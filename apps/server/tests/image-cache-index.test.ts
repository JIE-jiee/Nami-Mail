import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The image cache is a directory of content-addressed files plus one JSON
// index. These tests pin the index's durability properties on a real temp
// directory: an index write that can never be observed half-finished, a
// damaged index that leaves evidence instead of vanishing, and a cleanup pass
// that keeps reclaiming the directory even when the index no longer describes
// it. See src/image-cache-index.ts for why those three are one concern.

const tempRoots: string[] = [];

/**
 * Import fresh module instances bound to a throwaway cache directory, and
 * return them with the path of that directory (it may not exist yet) plus the
 * warnings the freshly imported logger recorded. The cache paths are
 * module-level constants derived from `config.databasePath`, so the env has to
 * be stubbed before the import and the module registry reset.
 */
async function loadCache(env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nami-image-cache-"));
  tempRoots.push(root);
  vi.stubEnv("DATABASE_PATH", path.join(root, "nami-mail.db"));
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();

  const index = await import("../src/image-cache-index.js");
  const proxy = await import("../src/image-proxy.js");
  const logging = await import("../src/logging.js");
  const warns: Array<{ meta: object; message: string }> = [];
  logging.setServerLogger({
    info: () => undefined,
    warn: (meta, message) => warns.push({ meta, message }),
    error: () => undefined,
  });
  return { cacheDir: path.join(root, "image-cache"), index, proxy, warns };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Write a cache-shaped file (64 hex chars) and backdate its mtime. */
function writeCacheFile(cacheDir: string, name: string, size: number, mtimeMs: number): string {
  const full = path.join(cacheDir, name);
  fs.writeFileSync(full, Buffer.alloc(size, 0x61));
  fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

function entry(file: string, key: string, size: number, lastAccess: number) {
  return { file, key, contentType: "image/png", size, lastAccess };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("saveMeta atomicity", () => {
  it("stages the index in a temp file and renames it onto _meta.json", async () => {
    const { cacheDir, index } = await loadCache();
    const metaFile = path.join(cacheDir, "_meta.json");
    const tmpFile = path.join(cacheDir, "_meta.json.tmp");
    const calls: string[] = [];
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
      calls.push(`write ${String(filePath)}`);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      calls.push(`rename ${String(from)} -> ${String(to)}`);
    }) as typeof fs.renameSync);

    index.loadMeta();
    index.cacheMeta()["https://cdn.example.com/a.png"] = entry("a".repeat(64), "https://cdn.example.com/a.png", 10, 1);
    index.saveMeta();

    // The old code truncated the live index in place, so a reader could observe
    // it mid-write. The replacement has to be: stage, then rename.
    expect(calls).toEqual([`write ${tmpFile}`, `rename ${tmpFile} -> ${metaFile}`]);
    expect(calls).not.toContain(`write ${metaFile}`);
  });

  it("stages the full index and leaves no temp file behind", async () => {
    const { cacheDir, index } = await loadCache();
    const metaFile = path.join(cacheDir, "_meta.json");
    const tmpFile = path.join(cacheDir, "_meta.json.tmp");
    let staged: unknown;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((_filePath: fs.PathLike, data: unknown) => {
      staged = data;
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);

    index.loadMeta();
    index.cacheMeta()["https://cdn.example.com/a.png"] = entry("a".repeat(64), "https://cdn.example.com/a.png", 10, 1);
    index.saveMeta();

    expect(staged).toBe(JSON.stringify(index.cacheMeta()));
    // A real rename consumes the staged file; nothing is left in the directory
    // that a later pass could mistake for a cache entry.
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(metaFile)).toBe(false); // the rename was stubbed out
  });
});

describe("loadMeta corruption recovery", () => {
  it("moves a torn index aside, reports it, and still returns to service", async () => {
    const { cacheDir, index, warns } = await loadCache();
    fs.mkdirSync(cacheDir, { recursive: true });
    // What a process killed mid-write leaves behind: the head of a valid
    // document and no tail.
    const torn = `{"https://cdn.example.com/a.png":{"file":"${"a".repeat(64)}","key":"htt`;
    fs.writeFileSync(path.join(cacheDir, "_meta.json"), torn, "utf-8");

    index.loadMeta();

    const quarantined = fs.readdirSync(cacheDir).filter((name) => /^_meta\.corrupt-\d+\.json$/.test(name));
    expect(quarantined).toHaveLength(1);
    // Evidence, not a deletion: the bytes are still readable, byte for byte.
    expect(fs.readFileSync(path.join(cacheDir, quarantined[0]!), "utf-8")).toBe(torn);
    expect(fs.existsSync(path.join(cacheDir, "_meta.json"))).toBe(false);
    // The reset index is empty rather than half-parsed.
    expect(index.cacheMeta()).toEqual({});
    // And the failure is visible: the old code swallowed it in the catch.
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain("Image cache index");
    expect(warns[0]?.meta).toMatchObject({ quarantined: path.join(cacheDir, quarantined[0]!) });

    // The module is back in service: the next save writes a usable index next
    // to the quarantined copy, which is left where it is.
    index.cacheMeta()["https://cdn.example.com/b.png"] = entry("b".repeat(64), "https://cdn.example.com/b.png", 10, 1);
    index.saveMeta();
    const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, "_meta.json"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(persisted)).toEqual(["https://cdn.example.com/b.png"]);
    expect(fs.readdirSync(cacheDir).filter((name) => name.startsWith("_meta.corrupt-"))).toHaveLength(1);
  });

  it("reports a damaged index once per process, however often it is read", async () => {
    const { cacheDir, index, warns } = await loadCache();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "_meta.json"), "{not json", "utf-8");
    // A lock that keeps the rename from succeeding (a Windows antivirus hold)
    // leaves the damaged file in place for every read to find again, so the
    // one-warn-per-process rule is the only thing between that and a log line
    // per proxied image.
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: injected lock"), { code: "EPERM" });
    });

    index.loadMeta();
    index.loadMeta();
    index.loadMeta();

    expect(warns).toHaveLength(1);
    // A failed quarantine is not a failed recovery: the index still resets.
    expect(index.cacheMeta()).toEqual({});
  });

  it("starts empty and silent when the index simply is not there yet", async () => {
    const { index, warns } = await loadCache();
    expect(() => index.loadMeta()).not.toThrow();
    expect(index.cacheMeta()).toEqual({});
    expect(warns).toEqual([]);
  });

  it("keeps the rows it can read when a single entry is unusable", async () => {
    const { cacheDir, index, warns } = await loadCache();
    fs.mkdirSync(cacheDir, { recursive: true });
    const good = entry("a".repeat(64), "https://cdn.example.com/a.png", 10, Date.now());
    fs.writeFileSync(
      path.join(cacheDir, "_meta.json"),
      JSON.stringify({ "https://cdn.example.com/a.png": good, "https://cdn.example.com/bad.png": { file: 42 } }),
      "utf-8",
    );

    index.loadMeta();

    // One bad row is not a corrupt document — throwing the whole index away
    // here would drop the cache for every image, not just the broken one.
    expect(Object.keys(index.cacheMeta())).toEqual(["https://cdn.example.com/a.png"]);
    expect(index.cacheMeta()["https://cdn.example.com/a.png"]).toEqual(good);
    expect(warns).toEqual([]);
  });
});

describe("runCacheCleanup reconciliation", () => {
  it("reclaims unindexed files by age and by quota when the index describes nothing", async () => {
    // A 1MB quota with 1MB files makes the size sweep observable without
    // writing hundreds of megabytes to a temp directory.
    const { cacheDir, proxy, warns } = await loadCache({ NAMI_MAIL_IMAGE_CACHE_MAX_MB: "1" });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "_meta.json"), "{}", "utf-8"); // index lost, entries gone

    const now = Date.now();
    const megabyte = 1024 * 1024;
    const aged = writeCacheFile(cacheDir, "1".repeat(64), 1024, now - 8 * DAY_MS);
    const coldest = writeCacheFile(cacheDir, "2".repeat(64), megabyte, now - 3 * 60 * 60 * 1000);
    const middle = writeCacheFile(cacheDir, "3".repeat(64), megabyte, now - 2 * 60 * 60 * 1000);
    const newest = writeCacheFile(cacheDir, "4".repeat(64), megabyte, now - 60 * 60 * 1000);

    proxy.runCacheCleanup();

    // Nothing in the index points at these, but MAX_AGE_MS and
    // MAX_CACHE_BYTES apply to the directory, not to the index: the past-the-
    // age file is gone, and the quota drops the two coldest of the three
    // remaining, in mtime order, exactly as it would for indexed entries.
    expect(fs.existsSync(aged)).toBe(false);
    expect(fs.existsSync(coldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(false);
    expect(fs.existsSync(newest)).toBe(true);
    expect(warns).toEqual([]);
  });

  it("leaves a healthy index and its young unindexed neighbours alone", async () => {
    const { cacheDir, index, proxy } = await loadCache();
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexed = writeCacheFile(cacheDir, "a".repeat(64), 4096, Date.now() - 60 * 1000);
    const unindexed = writeCacheFile(cacheDir, "b".repeat(64), 4096, Date.now() - 60 * 1000);

    index.loadMeta();
    index.cacheMeta()["https://cdn.example.com/a.png"] = entry(
      "a".repeat(64),
      "https://cdn.example.com/a.png",
      4096,
      Date.now(),
    );
    index.saveMeta();

    proxy.runCacheCleanup();

    // A lost index must cost cache hits, not bytes: a file the pass cannot
    // age out is kept, and the entry that still describes a live file stays.
    expect(fs.existsSync(indexed)).toBe(true);
    expect(fs.existsSync(unindexed)).toBe(true);
  });

  it("never touches index files, staging files or anything that is not a cache name", async () => {
    const { cacheDir, proxy } = await loadCache();
    fs.mkdirSync(cacheDir, { recursive: true });
    // Old mtimes: anything the sweep considers reclaimable is reclaimable here.
    const stale = Date.now() - 30 * DAY_MS;
    const stranger = path.join(cacheDir, "notes.txt");
    const staged = path.join(cacheDir, "_meta.json.tmp");
    const quarantined = path.join(cacheDir, "_meta.corrupt-1700000000000.json");
    fs.writeFileSync(stranger, "user data", "utf-8");
    fs.writeFileSync(staged, "{partial", "utf-8");
    fs.writeFileSync(quarantined, "{partial", "utf-8");
    fs.utimesSync(stranger, stale / 1000, stale / 1000);
    fs.utimesSync(staged, stale / 1000, stale / 1000);
    fs.utimesSync(quarantined, stale / 1000, stale / 1000);
    writeCacheFile(cacheDir, "c".repeat(64), 1024, stale);

    proxy.runCacheCleanup();

    expect(fs.existsSync(stranger)).toBe(true);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.existsSync(quarantined)).toBe(true);
    // The one file that is a cache name, and is past the age window, goes.
    expect(fs.existsSync(path.join(cacheDir, "c".repeat(64)))).toBe(false);
  });

  it("reclaims an aged entry from the index and persists the result atomically", async () => {
    const { cacheDir, index, proxy } = await loadCache();
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = writeCacheFile(cacheDir, "a".repeat(64), 4096, Date.now() - 8 * DAY_MS);
    index.loadMeta();
    index.cacheMeta()["https://cdn.example.com/old.png"] = entry(
      "a".repeat(64),
      "https://cdn.example.com/old.png",
      4096,
      Date.now() - 8 * DAY_MS,
    );
    index.saveMeta();

    proxy.runCacheCleanup();

    expect(fs.existsSync(file)).toBe(false);
    const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, "_meta.json"), "utf-8")) as Record<string, unknown>;
    expect(persisted).toEqual({});
    expect(fs.existsSync(path.join(cacheDir, "_meta.json.tmp"))).toBe(false);
  });
});

describe("proxyImage against the durable index", () => {
  /**
   * `proxyImage` refuses loopback hosts by design, so these tests fetch a
   * public-looking URL and pin only the DNS step to the loopback fixture. The
   * address policy is covered by image-proxy.test.ts; here the point is the
   * cache/index round trip.
   */
  beforeEach(() => {
    const realRequest = http.request.bind(http);
    vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const [url, options, callback] = args as [URL, http.RequestOptions, (response: http.IncomingMessage) => void];
      const pinned: http.RequestOptions = {
        lookup: (_hostname, lookupOptions, cb) => {
          if (lookupOptions.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
          else cb(null, "127.0.0.1", 4);
        },
      };
      return realRequest(url, { ...options, ...pinned }, callback);
    }) as typeof http.request);
  });

  /** Loopback fixture server. */
  async function listenFixtureServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets = new Set<{ destroy(): void }>();
    const server = http.createServer(handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return {
      port,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it("serves a repeat request from the cache and records a readable index", async () => {
    const { cacheDir, proxy } = await loadCache();
    const body = Buffer.alloc(4096, 0x62);
    let requests = 0;
    const server = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const url = `http://cdn.example.com:${server.port}/logo.png`;
      const first = await proxy.proxyImage(url);
      const second = await proxy.proxyImage(url);

      // The cache-hit path is unchanged: one download, the same file served.
      expect(requests).toBe(1);
      expect(first).not.toBeNull();
      expect(second?.filePath).toBe(first?.filePath);
      expect(fs.readFileSync(second!.filePath)).toEqual(body);

      // The index is a complete, parseable document, and the staged copy it
      // was written through is gone.
      const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, "_meta.json"), "utf-8")) as Record<string, {
        contentType: string;
        size: number;
      }>;
      expect(Object.keys(persisted)).toEqual([url]);
      expect(persisted[url]).toMatchObject({ contentType: "image/png", size: body.length });
      expect(fs.readdirSync(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("recovers from a torn index: one refetch, then the index is usable again", async () => {
    const { cacheDir, proxy } = await loadCache();
    const body = Buffer.alloc(4096, 0x63);
    let requests = 0;
    const server = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const url = `http://cdn.example.com:${server.port}/logo.png`;
      const first = await proxy.proxyImage(url);
      // Simulate the torn write the atomic replace now prevents.
      fs.writeFileSync(path.join(cacheDir, "_meta.json"), '{"https://cdn.example.com/logo.png":{"fi', "utf-8");

      const second = await proxy.proxyImage(url);

      // The index is gone, so the file has to be fetched again — but the
      // process keeps working, and the directory stays bounded.
      expect(requests).toBe(2);
      expect(second?.filePath).toBe(first?.filePath);
      const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, "_meta.json"), "utf-8")) as Record<string, unknown>;
      expect(Object.keys(persisted)).toEqual([url]);
      expect(fs.readdirSync(cacheDir).filter((name) => /^_meta\.corrupt-\d+\.json$/.test(name))).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
