import type { SqliteDb } from '../db/sqlite'

// SQLite-backed response cache with TTL + ETag, for the Nexus provider. Enables
// offline mode (serve stale on network failure) and respectful rate-limit usage
// (revalidate with If-None-Match instead of refetching whole payloads).

interface CacheRow {
  etag: string | null
  body: string
  fetched_at: number
  ttl_ms: number
}

export interface CacheHit {
  body: string
  etag: string | null
  fresh: boolean
}

export class NexusCache {
  constructor(private db: SqliteDb) {}

  private row(key: string): CacheRow | undefined {
    return this.db.prepare('SELECT etag, body, fetched_at, ttl_ms FROM nexus_cache WHERE key=?').get(key) as
      CacheRow | undefined
  }

  /** Fresh hit only (within TTL), else null. */
  get(key: string): CacheHit | null {
    const r = this.row(key)
    if (!r) return null
    const fresh = Date.now() - r.fetched_at <= r.ttl_ms
    return fresh ? { body: r.body, etag: r.etag, fresh: true } : null
  }

  /** Any entry, fresh or stale — for ETag revalidation and offline fallback. */
  getStale(key: string): CacheHit | null {
    const r = this.row(key)
    if (!r) return null
    return { body: r.body, etag: r.etag, fresh: Date.now() - r.fetched_at <= r.ttl_ms }
  }

  set(key: string, body: string, etag: string | null, ttlMs: number): void {
    this.db
      .prepare(
        `
      INSERT INTO nexus_cache (key, etag, body, fetched_at, ttl_ms) VALUES (?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET etag=excluded.etag, body=excluded.body, fetched_at=excluded.fetched_at, ttl_ms=excluded.ttl_ms
    `,
      )
      .run(key, etag, body, Date.now(), ttlMs)
  }

  /** Refresh the freshness window without changing the body (304 Not Modified). */
  touch(key: string): void {
    this.db.prepare('UPDATE nexus_cache SET fetched_at=? WHERE key=?').run(Date.now(), key)
  }

  clear(): void {
    this.db.prepare('DELETE FROM nexus_cache').run()
  }
}
