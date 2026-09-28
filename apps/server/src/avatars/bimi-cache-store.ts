import type { DatabaseHandle } from "../db.js";
import type { BimiDeps } from "./bimi.js";

// Persisted rows older than this are pruned once per boot; they can only
// re-enter through a fresh resolution, so the cache stays bounded by the
// sender domains recently seen by this installation.
const BIMI_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SQLite twin of the in-memory BIMI caches in avatars/bimi.ts: without it a
 * restart (or the logo host being unreachable later) would drop every brand
 * logo for the whole TTL window. The logo column doubles as the negative
 * cache (NULL = domain publishes no usable record).
 */
export function buildBimiPersistence(db: DatabaseHandle): {
  loadCachedLogo: NonNullable<BimiDeps["loadCachedLogo"]>;
  saveCachedLogo: NonNullable<BimiDeps["saveCachedLogo"]>;
} {
  const select = db.prepare("SELECT logo, resolved_at FROM bimi_logo_cache WHERE domain = ?");
  const upsert = db.prepare(
    "INSERT INTO bimi_logo_cache (domain, logo, resolved_at) VALUES (?, ?, ?) "
    + "ON CONFLICT(domain) DO UPDATE SET logo = excluded.logo, resolved_at = excluded.resolved_at",
  );
  return {
    loadCachedLogo: (domain) => {
      const row = select.get(domain) as { logo: string | null; resolved_at: string } | undefined;
      if (!row) return undefined;
      const resolvedAtMs = Date.parse(row.resolved_at);
      if (Number.isNaN(resolvedAtMs)) return undefined;
      return { logo: row.logo, resolvedAtMs };
    },
    saveCachedLogo: (domain, cached) => {
      upsert.run(domain, cached.logo, new Date(cached.resolvedAtMs).toISOString());
    },
  };
}

/**
 * Drops cache rows older than the retention window. Callers treat failures as
 * non-fatal: pruning is hygiene, not correctness — stale rows are ignored.
 */
export function pruneBimiLogoCache(db: DatabaseHandle): void {
  db.prepare("DELETE FROM bimi_logo_cache WHERE resolved_at < ?")
    .run(new Date(Date.now() - BIMI_CACHE_RETENTION_MS).toISOString());
}
