import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, openSync, writeSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type SqliteDb, applyPragmas, integrityCheck, withTransaction } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { computeChangeset, type ReleaseRow, type SnapshotRow } from './diff'
import { verifyManifest, type SignedManifest } from './manifest'
import { recordChangeset, listChangeset, setRowStatus, finalizeApply, recoverOnStartup } from './journal'
import { snapshotDatabase } from '../backup/snapshot'

const dirs: string[] = []
const dbs: SqliteDb[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'fail-'))
  dirs.push(d)
  return d
}
function track(db: SqliteDb): SqliteDb {
  dbs.push(db)
  return db
}
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      ;(db as unknown as { close?: () => void }).close?.()
    } catch {
      /**/
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /**/
    }
  }
})

function fullDb(path = ':memory:'): SqliteDb {
  const db = track(openTestDb(path))
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, priority INTEGER DEFAULT 0, load_order INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL,
      name TEXT NOT NULL, status TEXT DEFAULT 'pending', downloaded_size INTEGER DEFAULT 0);
  `)
  runMigrations(db)
  db.prepare('INSERT INTO profiles (id,name) VALUES (1, ?)').run('P')
  db.prepare(
    'INSERT INTO catalog_release (id, release_tag, release_counter, manifest_hash) VALUES (1, ?, 1, ?)',
  ).run('r1', 'mh1')
  db.prepare('INSERT INTO mods (id,profile_id,nexus_id,name,version) VALUES (1,1,101,?,?)').run(
    'Alpha',
    '1.0',
  )
  db.prepare(
    'INSERT INTO installed_snapshot (profile_id,release_id,nexus_id,mod_id,version,file_hash,load_order) VALUES (1,1,101,1,?,?,1)',
  ).run('1.0', 'ha')
  return db
}
const targetRelease: ReleaseRow[] = [
  {
    nexus_id: 101,
    name: 'Alpha',
    version: '2.0',
    file_id: 1,
    file_name: 'a.7z',
    file_hash: 'ha2',
    download_url: null,
    priority_order: 1,
  },
  {
    nexus_id: 102,
    name: 'Beta',
    version: '1.0',
    file_id: 2,
    file_name: 'b.7z',
    file_hash: 'hb',
    download_url: null,
    priority_order: 2,
  },
]
const snapshotOf = (db: SqliteDb) =>
  db
    .prepare(
      'SELECT nexus_id, version, file_id, file_hash, load_order FROM installed_snapshot WHERE profile_id=1',
    )
    .all() as SnapshotRow[]

function isHealthy(path: string): boolean {
  try {
    const db = track(openTestDb(path))
    return integrityCheck(db)
  } catch {
    return false
  } // open of a corrupt DB throws → unhealthy
}

describe('FAILURE SIMULATION', () => {
  it('KILL/POWER-LOSS during apply → recovery resumes, invariant still reachable (A5)', () => {
    const db = fullDb()
    const cs = computeChangeset(snapshotOf(db), targetRelease)
    recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)
    // simulate a crash with one row mid-download
    setRowStatus(db, listChangeset(db, 1, 1)[0].id, 'downloading')

    // RESTART: recovery resets in-flight work; snapshot is NOT advanced (still pre-delta)
    recoverOnStartup(db)
    expect(snapshotOf(db).find((s) => s.nexus_id === 101)!.file_hash).toBe('ha') // unchanged

    // resume to success → finalize → invariant holds
    for (const r of listChangeset(db, 1, 1)) setRowStatus(db, r.id, 'applied')
    expect(finalizeApply(db, 1, 1).committed).toBe(true)
    expect(computeChangeset(snapshotOf(db), targetRelease)).toHaveLength(0)
  })

  it('INTERRUPTED UPDATE (one download fails) → snapshot never advances (A2 gate)', () => {
    const db = fullDb()
    const cs = computeChangeset(snapshotOf(db), targetRelease)
    recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)
    const rows = listChangeset(db, 1, 1)
    setRowStatus(db, rows[0].id, 'applied')
    setRowStatus(db, rows[1].id, 'failed', { error: 'disco pieno' })
    expect(finalizeApply(db, 1, 1).committed).toBe(false)
    // pre-delta state preserved exactly
    expect(snapshotOf(db).find((s) => s.nexus_id === 101)!.file_hash).toBe('ha')
    expect(snapshotOf(db).some((s) => s.nexus_id === 102)).toBe(false)
  })

  it('POWER-LOSS mid-transaction → no partial writes (atomicity)', () => {
    const db = fullDb()
    const before = (db.prepare('SELECT COUNT(*) c FROM installed_snapshot').get() as { c: number }).c
    expect(() =>
      withTransaction(db, () => {
        db.prepare('INSERT INTO installed_snapshot (profile_id, nexus_id) VALUES (1, 999)').run()
        throw new Error('power loss')
      }),
    ).toThrow()
    const after = (db.prepare('SELECT COUNT(*) c FROM installed_snapshot').get() as { c: number }).c
    expect(after).toBe(before) // the half-written row was rolled back
  })

  it('CORRUPT DATABASE → detected, and restorable from a VACUUM INTO snapshot (C2)', () => {
    const dir = tmpDir()
    const dbPath = join(dir, 'app.db')
    const backupPath = join(dir, 'pre-delta.db')

    const db = track(openTestDb(dbPath))
    applyPragmas(db)
    db.exec('CREATE TABLE mods (id INTEGER PRIMARY KEY, name TEXT)')
    db.prepare('INSERT INTO mods (id,name) VALUES (1, ?)').run('SkyUI')
    snapshotDatabase(db, backupPath) // rollback point (whole DB)
    ;(db as unknown as { close: () => void }).close()
    dbs.splice(dbs.indexOf(db), 1)

    expect(isHealthy(backupPath)).toBe(true)

    // simulate on-disk corruption of the live DB (garbage over the header)
    const fd = openSync(dbPath, 'r+')
    writeSync(fd, Buffer.from('\x00CORRUPTED-HEADER\x00'.repeat(8)), 0, 100, 0)
    closeSync(fd)
    expect(isHealthy(dbPath)).toBe(false) // corruption is DETECTED

    // RESTORE: copy the snapshot back over the live DB
    copyFileSync(backupPath, dbPath)
    expect(isHealthy(dbPath)).toBe(true) // recovered
    const restored = track(openTestDb(dbPath))
    expect((restored.prepare('SELECT name FROM mods WHERE id=1').get() as { name: string }).name).toBe(
      'SkyUI',
    )
  })

  it('CORRUPT MANIFEST → ingest path rejects it (no release stored)', () => {
    // A malformed/garbage manifest is not parseable JSON: the renderer fetch +
    // JSON.parse fails before delta:ingest, and verifyManifest itself never throws.
    // Here we assert the verifier rejects a structurally-broken envelope.
    const r = verifyManifest({ manifest: { mods: [] } } as unknown as SignedManifest, {
      publicKeyPem: 'x',
      lastCounter: 0,
      allowedHosts: [],
    })
    expect(r.ok).toBe(false)
  })
})
