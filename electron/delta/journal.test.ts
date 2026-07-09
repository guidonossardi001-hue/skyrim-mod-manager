import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { computeChangeset, type SnapshotRow, type ReleaseRow } from './diff'
import {
  recordChangeset,
  listChangeset,
  setRowStatus,
  finalizeApply,
  recoverOnStartup,
  allTerminalSuccess,
} from './journal'

function setup(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, priority INTEGER DEFAULT 0, load_order INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL,
      name TEXT NOT NULL, status TEXT DEFAULT 'pending', downloaded_size INTEGER DEFAULT 0);
  `)
  runMigrations(db)
  db.prepare('INSERT INTO profiles (id,name) VALUES (1, ?)').run('P1')
  // a release the profile will move TO
  db.prepare(
    'INSERT INTO catalog_release (id, release_tag, release_counter, manifest_hash) VALUES (1, ?, 1, ?)',
  ).run('rel1', 'h1')
  // two installed mods + their snapshot baseline
  db.prepare(
    'INSERT INTO mods (id,profile_id,nexus_id,name,version,priority,load_order) VALUES (1,1,101,?,?,1,1)',
  ).run('Alpha', '1.0')
  db.prepare(
    'INSERT INTO mods (id,profile_id,nexus_id,name,version,priority,load_order) VALUES (2,1,102,?,?,2,2)',
  ).run('Beta', '1.0')
  db.prepare(
    'INSERT INTO installed_snapshot (profile_id,release_id,nexus_id,mod_id,version,file_hash,load_order) VALUES (1,1,101,1,?,?,1)',
  ).run('1.0', 'ha')
  db.prepare(
    'INSERT INTO installed_snapshot (profile_id,release_id,nexus_id,mod_id,version,file_hash,load_order) VALUES (1,1,102,2,?,?,2)',
  ).run('1.0', 'hb')
  return db
}

function snapshotOf(db: SqliteDb): SnapshotRow[] {
  return db
    .prepare(
      'SELECT nexus_id, version, file_id, file_hash, load_order FROM installed_snapshot WHERE profile_id=1',
    )
    .all() as SnapshotRow[]
}

// Target release: Alpha unchanged, Beta changed (hash hb→hb2, v2.0), Gamma added.
const targetRelease: ReleaseRow[] = [
  {
    nexus_id: 101,
    name: 'Alpha',
    version: '1.0',
    file_id: 1,
    file_name: 'a.7z',
    file_hash: 'ha',
    download_url: null,
    priority_order: 1,
  },
  {
    nexus_id: 102,
    name: 'Beta',
    version: '2.0',
    file_id: 2,
    file_name: 'b.7z',
    file_hash: 'hb2',
    download_url: null,
    priority_order: 2,
  },
  {
    nexus_id: 103,
    name: 'Gamma',
    version: '1.0',
    file_id: 3,
    file_name: 'g.7z',
    file_hash: 'hg',
    download_url: null,
    priority_order: 3,
  },
]

describe('delta journal', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = setup()
  })

  it('records a changeset (changed + added) and is idempotent on re-check (A1)', () => {
    const cs = computeChangeset(snapshotOf(db), targetRelease)
    expect(cs.map((c) => c.change_type).sort()).toEqual(['added', 'changed'])
    recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)
    // Re-record after a simulated partial failure: must NOT throw a UNIQUE clash
    setRowStatus(db, listChangeset(db, 1, 1)[0].id, 'failed', { error: 'boom' })
    expect(() => recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)).not.toThrow()
    expect(listChangeset(db, 1, 1)).toHaveLength(2)
  })

  it('gated commit refuses while any row is not terminal-success (A2)', () => {
    const cs = computeChangeset(snapshotOf(db), targetRelease)
    recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)
    const rows = listChangeset(db, 1, 1)
    setRowStatus(db, rows[0].id, 'applied')
    setRowStatus(db, rows[1].id, 'failed', { error: 'download fallito' })
    expect(allTerminalSuccess(db, 1, 1)).toBe(false)
    const res = finalizeApply(db, 1, 1)
    expect(res.committed).toBe(false)
    // snapshot NOT advanced: Beta still on hb / 1.0
    const beta = snapshotOf(db).find((s) => s.nexus_id === 102)!
    expect(beta.file_hash).toBe('hb')
  })

  it('commits atomically when all rows succeed and reaches the invariant (A2)', () => {
    const cs = computeChangeset(snapshotOf(db), targetRelease)
    recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)
    for (const r of listChangeset(db, 1, 1)) setRowStatus(db, r.id, 'applied')
    const res = finalizeApply(db, 1, 1)
    expect(res.committed).toBe(true)

    // installed_snapshot now equals the target release → re-diff yields zero changes
    expect(computeChangeset(snapshotOf(db), targetRelease)).toHaveLength(0)
    // Beta advanced to v2.0 / hb2 in BOTH snapshot and mods (single source of truth)
    expect(snapshotOf(db).find((s) => s.nexus_id === 102)!.file_hash).toBe('hb2')
    expect(
      (db.prepare('SELECT version FROM mods WHERE nexus_id=102').get() as { version: string }).version,
    ).toBe('2.0')
    // Gamma added to snapshot
    expect(snapshotOf(db).some((s) => s.nexus_id === 103)).toBe(true)
    // changeset cleared after commit
    expect(listChangeset(db, 1, 1)).toHaveLength(0)
  })

  it('recovers in-flight rows and downloads after a crash (A5)', () => {
    const cs = computeChangeset(snapshotOf(db), targetRelease)
    recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)
    const rows = listChangeset(db, 1, 1)
    setRowStatus(db, rows[0].id, 'downloading')
    db.prepare(
      "INSERT INTO downloads (profile_id, name, status, downloaded_size) VALUES (1, 'x', 'downloading', 999)",
    ).run()
    const rec = recoverOnStartup(db)
    expect(rec.resetRows).toBe(1)
    expect(rec.resetDownloads).toBe(1)
    expect(listChangeset(db, 1, 1, ['pending'])).toHaveLength(2)
    expect(
      (db.prepare("SELECT downloaded_size d FROM downloads WHERE status='pending'").get() as { d: number }).d,
    ).toBe(0)
  })
})
