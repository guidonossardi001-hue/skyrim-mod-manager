import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { DeltaService } from './service'
import { pinnedPublicKey } from './pinnedKey'
import { computeChangeset, type ReleaseRow, type SnapshotRow } from './diff'
import signedManifest from './examples/catalog.signed.json'

// End-to-end against the REAL pinned key + the REAL committed signed manifest:
// proves the production artifacts (embedded public key + signed catalog) are
// mutually consistent and that the whole pipeline ingest→verify→stage→commit→
// recovery works with no placeholder.

function fullDb(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, category TEXT, is_enabled INTEGER DEFAULT 1, is_installed INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0, load_order INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL,
      nexus_id INTEGER, file_id INTEGER, name TEXT NOT NULL, url TEXT, status TEXT DEFAULT 'pending', downloaded_size INTEGER DEFAULT 0);
  `)
  runMigrations(db)
  db.prepare('INSERT INTO profiles (id,name) VALUES (1, ?)').run('P1')
  return db
}
const snapshotOf = (db: SqliteDb) =>
  db
    .prepare(
      'SELECT nexus_id, version, file_id, file_hash, load_order FROM installed_snapshot WHERE profile_id=1',
    )
    .all() as SnapshotRow[]
const releaseOf = (db: SqliteDb, id: number) =>
  db
    .prepare(
      'SELECT nexus_id, name, version, file_id, file_name, file_hash, download_url, priority_order FROM catalog_release_mod WHERE release_id=?',
    )
    .all(id) as ReleaseRow[]

describe('DELTA E2E (real key + real signed manifest)', () => {
  let db: SqliteDb
  let svc: DeltaService
  beforeEach(() => {
    db = fullDb()
    svc = new DeltaService(db, { publicKeyPem: pinnedPublicKey() })
  })

  it('ingest → verify → stage → commit with the real artifacts, reaching the invariant', () => {
    // INGEST + VERIFY (signature checked against the embedded pinned key)
    const ing = svc.ingest(signedManifest as never)
    expect(ing.success).toBe(true)
    const releaseId = ing.releaseId!
    expect(releaseOf(db, releaseId)).toHaveLength(3)

    // STAGE (check → changeset; nothing installed ⇒ 3 additions)
    const chk = svc.check(1)
    expect(chk.ok).toBe(true)
    expect(chk.counts!.added).toBe(3)

    // APPLY (creates mods + downloads, queue would drive them)
    const ap = svc.apply(1, releaseId)
    expect(ap.queued).toBe(3)
    expect(
      (db.prepare("SELECT COUNT(*) c FROM downloads WHERE status='pending'").get() as { c: number }).c,
    ).toBe(3)

    // simulate all downloads+installs succeeding, then COMMIT (gated)
    svc.markAllApplied(1, releaseId)
    expect(svc.finalize(1, releaseId).committed).toBe(true)

    // INVARIANT: installed_snapshot == release ⇒ a fresh diff is empty
    expect(snapshotOf(db)).toHaveLength(3)
    expect(computeChangeset(snapshotOf(db), releaseOf(db, releaseId))).toHaveLength(0)
    // mods carry the release file identity
    const skse = db.prepare('SELECT version FROM mods WHERE nexus_id=17230').get() as { version: string }
    expect(skse.version).toBe('2.2.6')
  })

  it('re-ingesting the same manifest is idempotent (reused, no replay rejection)', () => {
    expect(svc.ingest(signedManifest as never).success).toBe(true)
    const again = svc.ingest(signedManifest as never)
    expect(again.success).toBe(true)
    expect(again.reused).toBe(true)
    expect((db.prepare('SELECT COUNT(*) c FROM catalog_release').get() as { c: number }).c).toBe(1)
  })

  it('rejects the real manifest under a DIFFERENT pinned key (authenticity)', () => {
    const stranger = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString()
    const wrong = new DeltaService(db, { publicKeyPem: stranger })
    const r = wrong.ingest(signedManifest as never)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/firma/i)
  })

  it('recovers a crash mid-apply and still reaches a consistent commit', () => {
    const releaseId = svc.ingest(signedManifest as never).releaseId!
    svc.check(1)
    svc.apply(1, releaseId)
    // crash: one row stuck downloading
    db.prepare(
      "UPDATE delta_changeset SET status='downloading' WHERE id=(SELECT MIN(id) FROM delta_changeset)",
    ).run()
    // RESTART
    const rec = svc.recover()
    expect(rec.resetRows).toBeGreaterThanOrEqual(1)
    // resume to success → commit
    svc.markAllApplied(1, releaseId)
    expect(svc.finalize(1, releaseId).committed).toBe(true)
    expect(computeChangeset(snapshotOf(db), releaseOf(db, releaseId))).toHaveLength(0)
  })
})
