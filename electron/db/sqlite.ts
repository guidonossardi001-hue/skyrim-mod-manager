// Engine-agnostic SQLite surface. Production passes a better-sqlite3 Database;
// tests pass a node:sqlite DatabaseSync. Both expose exec()/prepare(); we build
// transactions and pragmas on the COMMON subset (positional `?` params only) so
// the same migration/journal code runs identically under both engines.

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

/** Run fn inside a single transaction; ROLLBACK on any throw (no nesting). */
export function withTransaction<T>(db: SqliteDb, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw err
  }
}

export function getUserVersion(db: SqliteDb): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

export function setUserVersion(db: SqliteDb, v: number): void {
  // PRAGMA value cannot be parameterized; v is an internal integer (migration id).
  db.exec(`PRAGMA user_version = ${Math.trunc(v)}`)
}

/** Durability + integrity + concurrency pragmas (fixes A3). Call once on open. */
export function applyPragmas(db: SqliteDb): void {
  db.exec('PRAGMA foreign_keys = ON') // enforce declared FKs (A3)
  db.exec('PRAGMA journal_mode = WAL') // crash resilience + concurrent readers
  db.exec('PRAGMA busy_timeout = 5000') // wait, don't fail, on a locked DB (A4)
  db.exec('PRAGMA synchronous = NORMAL') // safe with WAL, good power-loss durability
  // ── Tuning (sqlite.org/pragma, phiresky 2020): il working set di un DB da launcher
  // (pochi MB) sta interamente in cache — azzera l'I/O ripetuto delle liste. Valori
  // deliberatamente moderati: cache per-connessione, l'app usa UNA connessione.
  db.exec('PRAGMA cache_size = -32000') // 32 MiB (negativo = KiB), default ~2 MiB
  db.exec('PRAGMA temp_store = MEMORY') // sort/temp table in RAM, mai su disco
  db.exec('PRAGMA mmap_size = 268435456') // letture memory-mapped (256 MiB), meno syscall
  // Statistiche del query planner mantenute incrementalmente (0x10002 = analisi
  // limitata all'apertura); il refresh periodico avviene alla chiusura (vedi main).
  db.exec('PRAGMA optimize = 0x10002')
}

/** Igiene WAL alla chiusura: checkpoint TRUNCATE (il -wal non resta grande tra le
 * sessioni, l'avvio dopo non paga il recovery) + refresh statistiche del planner.
 * Fail-soft: chiamata su before-quit, non deve mai bloccare l'uscita. */
export function checkpointOnQuit(db: SqliteDb): void {
  try {
    db.exec('PRAGMA optimize')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* chiusura comunque */
  }
}

/** Returns true iff PRAGMA integrity_check == 'ok' (fixes C2 detection). */
export function integrityCheck(db: SqliteDb): boolean {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  return row.integrity_check === 'ok'
}

export function columnExists(db: SqliteDb, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((r) => r.name === column)
}

export function tableExists(db: SqliteDb, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}
