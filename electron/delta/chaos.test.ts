import { describe, it, expect } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { computeChangeset, type ReleaseRow, type SnapshotRow } from './diff'
import { recordChangeset, listChangeset, setRowStatus, finalizeApply } from './journal'

function fullDb(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY); CREATE TABLE mods (id INTEGER PRIMARY KEY, profile_id INTEGER, nexus_id INTEGER, name TEXT, version TEXT, priority INTEGER, load_order INTEGER, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY, profile_id INTEGER, status TEXT, downloaded_size INTEGER);
  `)
  runMigrations(db)
  db.prepare('INSERT INTO profiles (id) VALUES (1)').run()
  db.prepare(
    "INSERT INTO catalog_release (id, release_tag, release_counter, manifest_hash) VALUES (1,'r',1,'h')",
  ).run()
  return db
}
const r = (n: number) => Math.floor(Math.random() * n)
const snapStr = (db: SqliteDb) =>
  JSON.stringify(
    db
      .prepare(
        'SELECT nexus_id, version, file_hash, load_order FROM installed_snapshot WHERE profile_id=1 ORDER BY nexus_id',
      )
      .all(),
  )
const readSnap = (db: SqliteDb) =>
  db
    .prepare(
      'SELECT nexus_id, version, file_id, file_hash, load_order FROM installed_snapshot WHERE profile_id=1',
    )
    .all() as SnapshotRow[]

describe('CHAOS: random apply outcomes never produce a partial commit', () => {
  it('holds the all-or-nothing invariant across many randomized rounds', () => {
    const db = fullDb()
    for (let iter = 0; iter < 80; iter++) {
      db.prepare('DELETE FROM installed_snapshot WHERE profile_id=1').run()
      db.prepare('DELETE FROM delta_changeset WHERE profile_id=1').run()

      const K = 4 + r(10)
      const release: ReleaseRow[] = []
      for (let i = 1; i <= K; i++) {
        release.push({
          nexus_id: i,
          name: `Mod${i}`,
          version: `1.${r(5)}`,
          file_id: i * 10,
          file_name: `f${i}.7z`,
          file_hash: `h${i}_${r(3)}`,
          download_url: null,
          priority_order: i,
        })
      }
      // random installed snapshot: subset with maybe-different identity + a stray removed mod
      const ins = db.prepare(
        'INSERT INTO installed_snapshot (profile_id, release_id, nexus_id, version, file_hash, load_order) VALUES (1,1,?,?,?,?)',
      )
      for (let i = 1; i <= K; i++) {
        if (r(10) < 6) ins.run(i, `1.${r(5)}`, `h${i}_${r(3)}`, i + (r(3) - 1))
      }
      if (r(2)) ins.run(999, '1.0', 'gone', 1) // removed candidate

      const cs = computeChangeset(readSnap(db), release)
      recordChangeset(db, { profileId: 1, fromReleaseId: 1, toReleaseId: 1 }, cs)

      const rows = listChangeset(db, 1, 1)
      let anyFailed = false
      for (const row of rows) {
        if (r(10) < 8) setRowStatus(db, row.id, 'applied')
        else {
          setRowStatus(db, row.id, 'failed', { error: 'chaos' })
          anyFailed = true
        }
      }

      const before = snapStr(db)
      const res = finalizeApply(db, 1, 1)

      if (rows.length > 0 && anyFailed) {
        // PARTIAL FAILURE → must refuse and leave the snapshot byte-identical
        expect(res.committed).toBe(false)
        expect(snapStr(db)).toBe(before)
      } else {
        // ALL APPLIED (or empty) → must commit and reach the invariant
        expect(res.committed).toBe(true)
        expect(computeChangeset(readSnap(db), release)).toHaveLength(0)
      }
    }
  })
})

describe('STRESS: large release diff + commit', () => {
  it('handles 1000 added mods end-to-end and reaches the invariant', () => {
    const db = fullDb()
    const N = 1000
    const release: ReleaseRow[] = []
    for (let i = 1; i <= N; i++) {
      release.push({
        nexus_id: i,
        name: `Mod${i}`,
        version: '1.0',
        file_id: i,
        file_name: `f${i}.7z`,
        file_hash: `h${i}`,
        download_url: null,
        priority_order: i,
      })
    }
    const cs = computeChangeset([], release)
    expect(cs).toHaveLength(N)
    recordChangeset(db, { profileId: 1, fromReleaseId: null, toReleaseId: 1 }, cs)
    for (const row of listChangeset(db, 1, 1)) setRowStatus(db, row.id, 'applied')
    const res = finalizeApply(db, 1, 1)
    expect(res.committed).toBe(true)
    expect(res.snapshotRows).toBe(N)
    expect(computeChangeset(readSnap(db), release)).toHaveLength(0)
  })
})
