import { describe, it, expect } from 'vitest'
import {
  type SqliteDb,
  applyPragmas,
  getUserVersion,
  integrityCheck,
  columnExists,
  withTransaction,
} from './sqlite'
import { openTestDb } from './openTestDb'
import { runMigrations, LATEST_SCHEMA_VERSION } from './migrations'

// Minimal base schema (subset of initDatabase) so migration FKs resolve.
function baseTables(db: SqliteDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL,
      nexus_id INTEGER, name TEXT NOT NULL, version TEXT);
    CREATE TABLE IF NOT EXISTS downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER,
      profile_id INTEGER NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'pending');
  `)
}

function freshDb(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  baseTables(db)
  return db
}

describe('migration framework', () => {
  it('migrates from 0 to the latest version', () => {
    const db = freshDb()
    expect(getUserVersion(db)).toBe(0)
    const r = runMigrations(db)
    expect(r.from).toBe(0)
    expect(r.to).toBe(LATEST_SCHEMA_VERSION)
    expect(r.applied).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1))
  })

  it('creates the delta tables and the file-identity columns', () => {
    const db = freshDb()
    runMigrations(db)
    for (const t of ['catalog_release', 'catalog_release_mod', 'installed_snapshot', 'delta_changeset']) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
      expect(row, `table ${t} should exist`).toBeTruthy()
    }
    expect(columnExists(db, 'mods', 'nexus_file_id')).toBe(true)
    expect(columnExists(db, 'mods', 'file_hash')).toBe(true)
  })

  it('adds the download integrity-hash columns (v9)', () => {
    const db = freshDb()
    runMigrations(db)
    expect(columnExists(db, 'downloads', 'file_hash')).toBe(true)
    expect(columnExists(db, 'downloads', 'hash_algo')).toBe(true)
  })

  it('creates the mod_translation mapping table (v10)', () => {
    const db = freshDb()
    runMigrations(db)
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mod_translation'").get()
    expect(t).toBeTruthy()
    for (const c of ['base_nexus_id', 'language', 'translation_nexus_id', 'translation_file_id', 'source']) {
      expect(columnExists(db, 'mod_translation', c), `column ${c}`).toBe(true)
    }
  })

  it('v11: rimuove UNIQUE(nexus_id) dal catalogo e consente più file per mod, preservando i dati', () => {
    const db = freshDb()
    // Schema VECCHIO reale (baseline pre-fix con UNIQUE inline), con dati esistenti.
    db.exec(`
      CREATE TABLE modlist_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nexus_id INTEGER UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        priority_order INTEGER DEFAULT 999,
        required INTEGER DEFAULT 0,
        size_mb INTEGER DEFAULT 0,
        notes TEXT
      );
    `)
    db.prepare("INSERT INTO modlist_catalog (nexus_id, name, category, notes) VALUES (100, 'Main', 'C', 'n')").run()
    db.prepare("INSERT INTO modlist_catalog (nexus_id, name, category) VALUES (200, 'Solo', 'C')").run()
    runMigrations(db)
    // dati preservati (id inclusi)
    const rows = db.prepare('SELECT id, nexus_id, name FROM modlist_catalog ORDER BY id').all() as {
      id: number
      nexus_id: number
      name: string
    }[]
    expect(rows.map((r) => [r.nexus_id, r.name])).toEqual([
      [100, 'Main'],
      [200, 'Solo'],
    ])
    // le colonne delle migrazioni 3/8 esistono ancora sulla tabella ricostruita
    expect(columnExists(db, 'modlist_catalog', 'nexus_file_id')).toBe(true)
    expect(columnExists(db, 'modlist_catalog', 'deploy_category')).toBe(true)
    // stesso mod, DUE file: ora permesso
    db.prepare("INSERT INTO modlist_catalog (nexus_id, nexus_file_id, name, category) VALUES (100, 1, 'Main f1', 'C')").run()
    db.prepare("INSERT INTO modlist_catalog (nexus_id, nexus_file_id, name, category) VALUES (100, 2, 'ESL flag', 'C')").run()
    // stessa coppia (nexus_id, file_id) due volte: rifiutata da OR IGNORE
    const dup = db
      .prepare("INSERT OR IGNORE INTO modlist_catalog (nexus_id, nexus_file_id, name, category) VALUES (100, 2, 'dup', 'C')")
      .run()
    expect(dup.changes).toBe(0)
    // righe senza file: una-per-mod come prima (indice parziale)
    const noFile = db
      .prepare("INSERT OR IGNORE INTO modlist_catalog (nexus_id, name, category) VALUES (200, 'Solo bis', 'C')")
      .run()
    expect(noFile.changes).toBe(0)
    expect(integrityCheck(db)).toBe(true)
  })

  it('v11: su un DB fresco (senza UNIQUE inline) crea solo gli indici', () => {
    const db = freshDb()
    db.exec(`
      CREATE TABLE modlist_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nexus_id INTEGER,
        name TEXT NOT NULL,
        category TEXT NOT NULL
      );
    `)
    runMigrations(db)
    db.prepare("INSERT INTO modlist_catalog (nexus_id, nexus_file_id, name, category) VALUES (1, 10, 'a', 'C')").run()
    db.prepare("INSERT INTO modlist_catalog (nexus_id, nexus_file_id, name, category) VALUES (1, 20, 'b', 'C')").run()
    const dup = db
      .prepare("INSERT OR IGNORE INTO modlist_catalog (nexus_id, nexus_file_id, name, category) VALUES (1, 20, 'c', 'C')")
      .run()
    expect(dup.changes).toBe(0)
  })

  it('is idempotent (re-running applies nothing and does not throw)', () => {
    const db = freshDb()
    runMigrations(db)
    const second = runMigrations(db)
    expect(second.applied).toEqual([])
    expect(second.to).toBe(LATEST_SCHEMA_VERSION)
  })

  it('passes integrity_check after migration', () => {
    const db = freshDb()
    runMigrations(db)
    expect(integrityCheck(db)).toBe(true)
  })

  it('enforces foreign keys with cascade (no orphan rows)', () => {
    const db = freshDb()
    runMigrations(db)
    db.prepare('INSERT INTO profiles (id, name) VALUES (1, ?)').run('P')
    db.prepare('INSERT INTO installed_snapshot (profile_id, nexus_id) VALUES (1, ?)').run(100)
    expect((db.prepare('SELECT count(*) c FROM installed_snapshot').get() as { c: number }).c).toBe(1)
    db.prepare('DELETE FROM profiles WHERE id=1').run()
    // ON DELETE CASCADE must have removed the snapshot row
    expect((db.prepare('SELECT count(*) c FROM installed_snapshot').get() as { c: number }).c).toBe(0)
  })

  it('rolls back a failing migration step atomically (user_version unchanged)', () => {
    const db = freshDb()
    const before = getUserVersion(db)
    expect(() =>
      withTransaction(db, () => {
        db.exec('CREATE TABLE tmp_ok (x INTEGER)')
        db.exec('THIS IS NOT VALID SQL') // throws mid-transaction
      }),
    ).toThrow()
    // the whole transaction rolled back: neither the table nor a version bump persisted
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE name='tmp_ok'").get()
    expect(exists).toBeFalsy()
    expect(getUserVersion(db)).toBe(before)
  })
})
