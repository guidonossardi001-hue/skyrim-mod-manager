import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { syncInstalledSnapshot } from './snapshot'
import { DeltaService } from './service'

function setup(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, is_installed INTEGER DEFAULT 0, priority INTEGER DEFAULT 0,
      load_order INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL,
      name TEXT NOT NULL, status TEXT DEFAULT 'pending', downloaded_size INTEGER DEFAULT 0);
  `)
  runMigrations(db) // adds nexus_file_id/file_hash to mods; creates installed_snapshot + catalog_release* + delta_changeset
  db.prepare('INSERT INTO profiles (id,name) VALUES (1,?)').run('P1')
  return db
}

function addMod(
  db: SqliteDb,
  id: number,
  nexus: number | null,
  version: string | null,
  installed: number,
  lo = 0,
): void {
  db.prepare(
    'INSERT INTO mods (id,profile_id,nexus_id,name,version,is_installed,priority,load_order) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, 1, nexus, `Mod${id}`, version, installed, lo, lo)
}

function snap(db: SqliteDb): { nexus_id: number; version: string | null; release_id: number | null }[] {
  return db
    .prepare(
      'SELECT nexus_id, version, release_id FROM installed_snapshot WHERE profile_id=1 ORDER BY nexus_id',
    )
    .all() as never
}

describe('installed_snapshot baseline seeding', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = setup()
  })

  it('seeds only installed, nexus-identified mods', () => {
    addMod(db, 1, 101, '1.0', 1, 1)
    addMod(db, 2, 102, '1.0', 1, 2)
    addMod(db, 3, 103, '1.0', 0, 3) // not installed → excluded
    addMod(db, 4, null, '1.0', 1, 4) // no nexus_id → excluded
    const r = syncInstalledSnapshot(db, 1)
    expect(r).toEqual({ rows: 2, added: 2, removed: 0 })
    expect(snap(db).map((s) => s.nexus_id)).toEqual([101, 102])
  })

  it('is idempotent and tracks a local version bump', () => {
    addMod(db, 1, 101, '1.0', 1, 1)
    syncInstalledSnapshot(db, 1)
    db.prepare("UPDATE mods SET version='2.0' WHERE id=1").run()
    const r = syncInstalledSnapshot(db, 1)
    expect(r).toEqual({ rows: 1, added: 0, removed: 0 })
    expect(snap(db)[0].version).toBe('2.0')
  })

  it('reconciles a locally uninstalled mod out of the baseline', () => {
    addMod(db, 1, 101, '1.0', 1, 1)
    addMod(db, 2, 102, '1.0', 1, 2)
    syncInstalledSnapshot(db, 1)
    db.prepare('UPDATE mods SET is_installed=0 WHERE id=2').run()
    const r = syncInstalledSnapshot(db, 1)
    expect(r).toEqual({ rows: 1, added: 0, removed: 1 })
    expect(snap(db).map((s) => s.nexus_id)).toEqual([101])
  })

  it('preserves a delta-origin release_id on resync (provenance)', () => {
    addMod(db, 1, 101, '1.0', 1, 1)
    db.prepare(
      'INSERT INTO installed_snapshot (profile_id,release_id,nexus_id,mod_id,version,load_order) VALUES (1,5,101,1,?,1)',
    ).run('1.0')
    syncInstalledSnapshot(db, 1)
    expect(snap(db)[0].release_id).toBe(5) // not clobbered to NULL
  })
})

describe('DeltaService.checkUpdates (snapshot vs latest release)', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = setup()
  })

  function ingestRelease(): void {
    db.prepare(
      'INSERT INTO catalog_release (id, release_tag, release_counter, manifest_hash) VALUES (1, ?, 1, ?)',
    ).run('rel1', 'h1')
    const ins = db.prepare(
      'INSERT INTO catalog_release_mod (release_id, nexus_id, name, category, priority_order, version, file_id, file_name, file_hash, download_url) VALUES (1,?,?,?,?,?,?,?,?,?)',
    )
    ins.run(101, 'Mod1', 'other', 1, '2.0', 11, 'm1.7z', null, null) // changed (installed 1.0 → 2.0)
    ins.run(102, 'Mod2', 'other', 2, '1.0', 12, 'm2.7z', null, null) // unchanged
    ins.run(103, 'NewMod', 'other', 3, '1.0', 13, 'm3.7z', null, null) // added (not installed)
  }

  it('returns real per-mod drift derived from the persistent snapshot', () => {
    addMod(db, 1, 101, '1.0', 1, 1)
    addMod(db, 2, 102, '1.0', 1, 2)
    ingestRelease()
    const svc = new DeltaService(db, { publicKeyPem: 'unused-for-check' })

    const res = svc.checkUpdates(1)
    expect(res.ok).toBe(true)
    expect(res.snapshotRows).toBe(2) // baseline auto-seeded from installed mods
    const changed = res.updates.find((u) => u.nexus_id === 101)
    expect(changed).toMatchObject({
      change_type: 'changed',
      from_version: '1.0',
      to_version: '2.0',
      name: 'Mod1',
    })
    const added = res.updates.find((u) => u.nexus_id === 103)
    expect(added?.change_type).toBe('added')
    expect(res.updates.some((u) => u.nexus_id === 102)).toBe(false) // unchanged → not reported
  })

  it('fails closed (ok:false) when no signed release has been ingested', () => {
    addMod(db, 1, 101, '1.0', 1, 1)
    const svc = new DeltaService(db, { publicKeyPem: 'unused' })
    const res = svc.checkUpdates(1)
    expect(res.ok).toBe(false)
    expect(res.snapshotRows).toBe(1) // snapshot still seeded even with no release
    expect(res.updates).toEqual([])
  })
})
