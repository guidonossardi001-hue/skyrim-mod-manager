import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyPragmas, integrityCheck, type SqliteDb } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import {
  snapshotDatabase,
  atomicWriteFile,
  writeChecksumSidecar,
  verifyChecksum,
} from './snapshot'

const dirs: string[] = []
const openDbs: SqliteDb[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'snap-'))
  dirs.push(d)
  return d
}
function track(db: SqliteDb): SqliteDb {
  openDbs.push(db)
  return db
}
afterEach(() => {
  // Close DB handles first (Windows locks the file) then best-effort remove temp dirs.
  for (const db of openDbs.splice(0)) {
    try {
      ;(db as unknown as { close?: () => void }).close?.()
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* OS temp, swept later */
    }
  }
})

function seededDb(): SqliteDb {
  const db = track(openTestDb())
  applyPragmas(db)
  db.exec(
    'CREATE TABLE catalog_release (id INTEGER PRIMARY KEY, tag TEXT); CREATE TABLE mods (id INTEGER PRIMARY KEY, name TEXT)',
  )
  db.prepare('INSERT INTO catalog_release (id, tag) VALUES (1, ?)').run('rel-A')
  db.prepare('INSERT INTO mods (id, name) VALUES (1, ?)').run('SkyUI')
  return db
}

describe('snapshotDatabase (whole-DB rollback point, C2)', () => {
  it('captures every table consistently and the snapshot passes integrity_check', async () => {
    const db = seededDb()
    const dest = join(tmp(), 'pre-delta.db')
    snapshotDatabase(db, dest)
    expect(existsSync(dest)).toBe(true)

    const snap = track(openTestDb(dest))
    // both tables (not just mods) survive in the snapshot
    expect((snap.prepare('SELECT tag FROM catalog_release WHERE id=1').get() as { tag: string }).tag).toBe(
      'rel-A',
    )
    expect((snap.prepare('SELECT name FROM mods WHERE id=1').get() as { name: string }).name).toBe('SkyUI')
    expect(integrityCheck(snap)).toBe(true)
  })
})

describe('atomic write + checksum (M2)', () => {
  it('verifies a freshly written backup', async () => {
    const f = join(tmp(), 'backup.json')
    atomicWriteFile(f, JSON.stringify({ a: 1 }))
    await writeChecksumSidecar(f)
    expect(await verifyChecksum(f)).toBe(true)
  })

  it('refuses a corrupt / truncated restore point instead of trusting it', async () => {
    const f = join(tmp(), 'backup.json')
    atomicWriteFile(f, JSON.stringify({ a: 1, big: 'x'.repeat(1000) }))
    await writeChecksumSidecar(f)
    // simulate a power-loss truncation AFTER the checksum was written
    writeFileSync(f, '{ truncated')
    expect(await verifyChecksum(f)).toBe(false)
  })

  it('reports false when the sidecar is missing', async () => {
    const f = join(tmp(), 'nochk.json')
    atomicWriteFile(f, 'data')
    expect(await verifyChecksum(f)).toBe(false)
  })
})
