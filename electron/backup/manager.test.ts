import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type SqliteDb, applyPragmas, integrityCheck } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { createProfileBackup, listBackups, restoreProfileBackup, deleteBackup } from './manager'

const dirs: string[] = []
const dbs: SqliteDb[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bk-'))
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

function seededDb(): SqliteDb {
  const db = track(openTestDb())
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, author TEXT, category TEXT, description TEXT, file_size INTEGER DEFAULT 0,
      install_path TEXT, is_enabled INTEGER DEFAULT 1, is_installed INTEGER DEFAULT 0, load_order INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0, tags TEXT DEFAULT '[]', conflicts TEXT DEFAULT '[]', requires TEXT DEFAULT '[]',
      translation_it INTEGER DEFAULT 0, nexus_url TEXT, thumbnail_url TEXT, nexus_file_id INTEGER, file_hash TEXT,
      created_at TEXT, updated_at TEXT);
  `)
  db.prepare('INSERT INTO profiles (id, name) VALUES (1, ?)').run('P1')
  db.prepare(
    'INSERT INTO mods (profile_id, nexus_id, name, version, nexus_file_id, file_hash) VALUES (1, 1137, ?, ?, ?, ?)',
  ).run('SkyUI', '5.2', 9001, 'hashA')
  db.prepare('INSERT INTO mods (profile_id, nexus_id, name, version) VALUES (1, 17230, ?, ?)').run(
    'SKSE64',
    '2.2.6',
  )
  return db
}

describe('backup manager core', () => {
  it('creates a checksum-validated backup', async () => {
    const db = seededDb()
    const dir = tmp()
    const res = await createProfileBackup(db, dir, 1, 'manual')
    expect(res.success).toBe(true)
    expect(existsSync(res.path)).toBe(true)
    expect(existsSync(`${res.path}.sha256`)).toBe(true)
    const list = await listBackups(dir)
    expect(list).toHaveLength(1)
    expect(list[0].valid).toBe(true)
  })

  it('round-trips mods INCLUDING the delta identity columns (lockstep)', async () => {
    const db = seededDb()
    const dir = tmp()
    const { path } = await createProfileBackup(db, dir, 1)
    db.prepare('DELETE FROM mods WHERE profile_id=1').run() // simulate loss
    expect((db.prepare('SELECT COUNT(*) c FROM mods').get() as { c: number }).c).toBe(0)

    const r = await restoreProfileBackup(db, path, 1)
    expect(r.success).toBe(true)
    expect(r.restored).toBe(2)
    const skyui = db.prepare('SELECT nexus_file_id, file_hash FROM mods WHERE nexus_id=1137').get() as {
      nexus_file_id: number
      file_hash: string
    }
    expect(skyui.nexus_file_id).toBe(9001) // NOT dropped on restore
    expect(skyui.file_hash).toBe('hashA')
  })

  it('REFUSES a corrupt restore point instead of trusting it', async () => {
    const db = seededDb()
    const dir = tmp()
    const { path } = await createProfileBackup(db, dir, 1)
    writeFileSync(path, '{ truncated json') // power-loss style corruption after checksum
    expect((await listBackups(dir))[0].valid).toBe(false)
    const r = await restoreProfileBackup(db, path, 1)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/corrotto/i)
  })

  it('optionally captures a whole-DB VACUUM INTO snapshot that passes integrity_check', async () => {
    const db = seededDb()
    const dir = tmp()
    const res = await createProfileBackup(db, dir, 1, 'pre-delta', { snapshotDb: true })
    expect(res.dbSnapshotPath && existsSync(res.dbSnapshotPath)).toBe(true)
    const snap = track(openTestDb(res.dbSnapshotPath!))
    expect(integrityCheck(snap)).toBe(true)
    expect((snap.prepare('SELECT COUNT(*) c FROM mods').get() as { c: number }).c).toBe(2)
  })

  it('deleteBackup removes json + sidecar + db snapshot', async () => {
    const db = seededDb()
    const dir = tmp()
    const res = await createProfileBackup(db, dir, 1, 'x', { snapshotDb: true })
    deleteBackup(res.path)
    expect(existsSync(res.path)).toBe(false)
    expect(existsSync(`${res.path}.sha256`)).toBe(false)
    expect(existsSync(res.dbSnapshotPath!)).toBe(false)
  })
})
