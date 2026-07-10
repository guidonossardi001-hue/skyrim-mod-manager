import { describe, it, expect } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { verifyManifest, DEFAULT_ALLOWED_HOSTS, type SignedManifest } from './manifest'
import { pinnedPublicKey } from './pinnedKey'
import { DeltaService } from './service'
import signed from './examples/catalog.remote.signed.json'

// The committed, REAL signed remote catalog (file_id / file_hash(sha256) / version
// per mod), produced by scripts/build_remote_catalog.mjs and signed with the release
// key. These tests prove it verifies against the PINNED public key the runtime uses
// and drives genuine drift detection — no mock anywhere.

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
  runMigrations(db)
  db.prepare('INSERT INTO profiles (id,name) VALUES (1,?)').run('P1')
  return db
}

describe('real signed remote catalog (T2)', () => {
  it('verifies against the pinned Ed25519 key', () => {
    const res = verifyManifest(signed as SignedManifest, {
      publicKeyPem: pinnedPublicKey(),
      lastCounter: 0,
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    })
    expect(res.ok).toBe(true)
    expect(res.manifest?.release_counter).toBe(2)
  })

  it('every mod carries real version / file_id / sha256 file_hash on an allow-listed host', () => {
    const mods = (signed as SignedManifest).manifest.mods
    expect(mods.length).toBeGreaterThanOrEqual(5)
    for (const m of mods) {
      expect(typeof m.version).toBe('string')
      expect(Number.isInteger(m.file_id)).toBe(true)
      expect(m.file_hash).toMatch(/^[0-9a-f]{64}$/) // genuine sha256, not a stub
      expect(DEFAULT_ALLOWED_HOSTS.some((r) => r.test(m.download_url!))).toBe(true)
    }
  })

  it('rejects a tampered manifest (flips one byte of a version)', () => {
    const tampered = structuredClone(signed) as SignedManifest
    tampered.manifest.mods[0].version = tampered.manifest.mods[0].version + 'x'
    const res = verifyManifest(tampered, {
      publicKeyPem: pinnedPublicKey(),
      lastCounter: 0,
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    })
    expect(res.ok).toBe(false)
  })

  it('ingests via DeltaService and drives real drift vs an older install', () => {
    const db = setup()
    // Installed set: SkyUI current (5.2SE) + CBBE old (2.0).
    db.prepare(
      "INSERT INTO mods (id,profile_id,nexus_id,name,version,is_installed,load_order) VALUES (1,1,1137,'SkyUI','5.2SE',1,2)",
    ).run()
    db.prepare(
      "INSERT INTO mods (id,profile_id,nexus_id,name,version,is_installed,load_order) VALUES (2,1,198,'CBBE','2.0',1,4)",
    ).run()

    const svc = new DeltaService(db, { publicKeyPem: pinnedPublicKey() })
    const ing = svc.ingest(signed as SignedManifest)
    expect(ing.success).toBe(true)
    expect((db.prepare('SELECT COUNT(*) c FROM catalog_release_mod').get() as { c: number }).c).toBe(6)

    const res = svc.checkUpdates(1)
    expect(res.ok).toBe(true)
    const cbbe = res.updates.find((u) => u.nexus_id === 198)
    expect(cbbe).toMatchObject({ change_type: 'changed', from_version: '2.0', to_version: '2.7.0' })
    // SkyUI is at the catalog version → not reported as drift.
    expect(res.updates.some((u) => u.nexus_id === 1137)).toBe(false)
    // Mods present in the catalog but not installed surface as additions.
    expect(res.updates.some((u) => u.change_type === 'added')).toBe(true)
  })
})
