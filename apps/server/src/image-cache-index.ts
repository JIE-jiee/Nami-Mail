import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { serverLog } from "./logging.js";

// ---------------------------------------------------------------------------
// Cache directory + index durability
//
// The image cache is a directory of content-addressed files (the SHA-256 of the
// source URL) plus one JSON index that maps URL -> { file, contentType, size,
// lastAccess }. This module owns the pair and the two ways they can drift apart:
//
//   1. A half-written index. `fs.writeFileSync` truncates its target before it
//      writes, so a process killed mid-write (full disk, a Windows antivirus
//      lock, a power cut) left a `_meta.json` that no longer parsed — and the
//      old reader threw the entire index away, silently. `saveMeta` now stages
//      the bytes and renames them into place, so a reader sees either the old
//      index or the new one.
//
//   2. A lost index. The filenames are `sha256(url)`, so the URL keys cannot be
//      recovered from the directory — there is no rebuild to do, and pretending
//      otherwise would just re-derive a worse index. The self-healing comes
//      from the other direction: `listUnindexedFiles` hands the cleanup pass the
//      files no entry claims, and the existing age/quota rules are applied to
//      them there. A lost index costs cache hits, never disk.
// ---------------------------------------------------------------------------

export const CACHE_DIR = path.join(path.dirname(config.databasePath), "image-cache");

const META_FILE = path.join(CACHE_DIR, "_meta.json");

/** Staging path `saveMeta` renames onto META_FILE. */
const META_TMP_FILE = path.join(CACHE_DIR, "_meta.json.tmp");

/** Only hex characters — produced by SHA-256 digest. */
const SAFE_FILENAME_RE = /^[0-9a-f]{64}$/;

/**
 * Ceiling on the `statSync` calls one reconciliation pass spends on files the
 * index does not claim. The healthy case is ~0 calls (every file is claimed and
 * is skipped on the filename alone); the ceiling only binds after an index
 * loss, where the whole directory is a candidate. Bounding it keeps that one
 * recovery pass from turning a 50 000-entry directory into 50 000 synchronous
 * stats on the startup path. The trade-off: a pass that hits the ceiling
 * under-counts the quota for the files it did not look at, which under-evicts
 * rather than over-evicts, and the files it skipped are re-examined on later
 * passes — the age rule alone drains the directory, since a file only survives
 * a pass while it is younger than MAX_AGE_MS.
 */
const MAX_UNINDEXED_STATS_PER_PASS = 2_000;

export interface CacheEntry {
  /** Relative filename inside CACHE_DIR (sha256 hex). */
  file: string;
  /** Original URL or "cid:<contentId>" for inline images. */
  key: string;
  /** MIME content-type. */
  contentType: string;
  /** File size in bytes. */
  size: number;
  /** Epoch-ms when this entry was last accessed. */
  lastAccess: number;
}

/**
 * The live index. `loadMeta` rebinds this variable, so every caller must read
 * it through `cacheMeta()` *after* `loadMeta()` and re-read it at each use.
 * That is not incidental: `proxyImage` awaits the network between loading the
 * index and writing an entry, so a second in-flight call can have replaced the
 * object in between. Re-reading the binding is what makes both calls mutate one
 * index instead of two diverging copies of it.
 */
let meta: Record<string, CacheEntry> = {};

let corruptMetaReported = false;

export function cacheMeta(): Record<string, CacheEntry> {
  return meta;
}

export function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** Content-hash filename — SHA-256 hex is path-traversal-safe by construction. */
export function cacheFilename(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Validate a filename is a safe hex string and resolves inside CACHE_DIR. */
export function safeCachePath(filename: string): string | null {
  if (!SAFE_FILENAME_RE.test(filename)) return null;
  const resolved = path.resolve(CACHE_DIR, filename);
  if (resolved !== path.join(CACHE_DIR, filename)) return null;
  return resolved;
}

/**
 * A single unusable row must not void the rest of the index, so bad rows are
 * dropped rather than treated as corruption. `file` is deliberately not shape-
 * checked: `safeCachePath` already refuses to unlink anything that is not a
 * 64-hex name, and the writer only ever produces such names.
 */
function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CacheEntry>;
  return (
    typeof entry.file === "string"
    && typeof entry.key === "string"
    && typeof entry.contentType === "string"
    && Number.isFinite(entry.size)
    && Number.isFinite(entry.lastAccess)
  );
}

function parseMeta(raw: string): Record<string, CacheEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries: Record<string, CacheEntry> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isCacheEntry(value)) entries[key] = value;
  }
  return entries;
}

/**
 * Move a damaged index aside instead of deleting or overwriting it: the bytes
 * stay on disk for a bug report, and the next `saveMeta` can no longer be
 * confused by them. The rename is best-effort because the reason the file is
 * worth keeping (a torn write) is also the reason it may still be held open —
 * a failed rename must not escalate a damaged index into a crash.
 *
 * The warn is emitted at most once per process. If the rename keeps failing
 * (a Windows antivirus lock), every proxied image would otherwise re-read and
 * re-report the same damaged file.
 */
function quarantineCorruptMeta(reason: string): void {
  const quarantined = path.join(CACHE_DIR, `_meta.corrupt-${Date.now()}.json`);
  let moved = false;
  try {
    fs.renameSync(META_FILE, quarantined);
    moved = true;
  } catch {
    // left in place; the empty index below is still the safe state to run in
  }
  if (corruptMetaReported) return;
  corruptMetaReported = true;
  serverLog.warn(
    { metaFile: META_FILE, quarantined: moved ? quarantined : null, reason },
    "Image cache index was unusable and has been reset; unindexed cache files are reclaimed by age and size",
  );
}

/**
 * Load the index into the module-level `meta`. A missing or unreadable file
 * (first run, a lock) is the ordinary empty-start case and stays silent: the
 * reconciliation in the cleanup pass reclaims unindexed files either way, so
 * nothing leaks. An index that *parses wrong* is a different failure — the old
 * code folded it into the same silent reset — so it is quarantined and reported.
 */
export function loadMeta(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(META_FILE, "utf-8");
  } catch {
    meta = {};
    return;
  }
  const entries = parseMeta(raw);
  if (!entries) {
    quarantineCorruptMeta("the index did not parse as a JSON object of cache entries");
    meta = {};
    return;
  }
  meta = entries;
}

/**
 * Persist the index with a write-then-rename.
 *
 * `rename` is atomic on POSIX and on Windows, including onto an existing
 * target: POSIX rename(2) replaces atomically, and Node's Windows
 * implementation issues MoveFileExW with MOVEFILE_REPLACE_EXISTING, which
 * replaces an existing destination. A concurrent reader therefore observes
 * either the previous index or the new one and never a truncated mix, which is
 * exactly the state the old direct write could leave behind.
 *
 * A failed write can leave a partial `_meta.json.tmp` behind. It is harmless:
 * the next save overwrites it, and it is not a 64-hex name, so the
 * reconciliation below never treats it as a cache file.
 *
 * Failures keep the module's existing shape — the error propagates, and the
 * callers that run outside a request already degrade it to a log line.
 */
export function saveMeta(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(META_TMP_FILE, JSON.stringify(meta), "utf-8");
  fs.renameSync(META_TMP_FILE, META_FILE);
}

/** A cache file that no live index entry claims. */
export interface UnindexedFile {
  /** Filename inside CACHE_DIR (sha256 hex). */
  file: string;
  size: number;
  /**
   * File mtime in epoch-ms. For an unindexed file this is when it was
   * fetched — the closest available stand-in for `lastAccess`, which lives in
   * the index that was lost.
   */
  lastAccess: number;
}

/**
 * One directory listing of the files no live entry claims, each with the size
 * and mtime the cleanup pass needs to apply the usual eviction rules to it.
 * Without this, a lost index means the directory is invisible to every pass and
 * grows without bound.
 *
 * Only 64-hex names are considered, so the index files themselves
 * (`_meta.json`, `_meta.json.tmp`, `_meta.corrupt-*.json`) and anything else
 * that lands in the directory are never touched. The scan is bounded by
 * `MAX_UNINDEXED_STATS_PER_PASS`; see that constant for the trade-off.
 */
export function listUnindexedFiles(): UnindexedFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return [];
  }
  const claimed = new Set<string>();
  for (const entry of Object.values(meta)) claimed.add(entry.file);

  const unindexed: UnindexedFile[] = [];
  for (const name of names) {
    if (unindexed.length >= MAX_UNINDEXED_STATS_PER_PASS) break;
    if (claimed.has(name) || !SAFE_FILENAME_RE.test(name)) continue;
    const full = safeCachePath(name);
    if (!full) continue;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      unindexed.push({ file: name, size: stat.size, lastAccess: stat.mtimeMs });
    } catch {
      // vanished between the listing and the stat — nothing left to reclaim
    }
  }
  return unindexed;
}
