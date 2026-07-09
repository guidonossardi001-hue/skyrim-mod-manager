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
