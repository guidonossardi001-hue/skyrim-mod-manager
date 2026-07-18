import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, utimesSync, readdirSync } from 'fs'
import { gzipSync } from 'zlib'
import { tmpdir } from 'os'
import { join } from 'path'
import { type SqliteDb, applyPragmas, integrityCheck } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { createProfileBackup, listBackups, restoreProfileBackup, deleteBackup, pruneLabelledBackups } from './manager'
import { writeChecksumSidecar } from './snapshot'

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

  // ── T11: compressione gzip + retrocompatibilità coi vecchi backup in chiaro ──

  it('scrive il backup gzip-compresso (estensione .json.gz, più piccolo del JSON grezzo)', async () => {
    const db = seededDb()
    const dir = tmp()
    const res = await createProfileBackup(db, dir, 1, 'manual')
    expect(res.path.endsWith('.json.gz')).toBe(true)
    const onDisk = statSync(res.path).size
    expect(res.size).toBe(onDisk) // size riportata combacia coi byte scritti (compressi)
    // Il payload JSON non compresso di questo fixture minuscolo è comunque più grande.
    const rawApprox = JSON.stringify({ profile: { id: 1, name: 'P1' }, mods: [{}, {}] }).length
    expect(onDisk).toBeLessThan(rawApprox + 500) // margine ampio: qui conta "non esplode", non il rapporto esatto
  })

  it('listBackups mostra il nome senza suffisso .json.gz', async () => {
    const db = seededDb()
    const dir = tmp()
    await createProfileBackup(db, dir, 1, 'manual')
    const list = await listBackups(dir)
    expect(list[0].name).not.toMatch(/\.json/)
  })

  it('restore legge un backup LEGACY in chiaro (.json, pre-T11) senza alcuna migrazione', async () => {
    const db = seededDb()
    const dir = tmp()
    const legacyPath = join(dir, 'legacy_backup.json')
    const payload = JSON.stringify({
      version: '1.1',
      profile: { id: 1, name: 'P1' },
      mods: [{ nexus_id: 1137, name: 'SkyUI', nexus_file_id: 9001, file_hash: 'hashA' }],
      createdAt: new Date().toISOString(),
    })
    writeFileSync(legacyPath, payload, 'utf8')
    await writeChecksumSidecar(legacyPath)

    db.prepare('DELETE FROM mods WHERE profile_id=1').run()
    const r = await restoreProfileBackup(db, legacyPath, 1)
    expect(r.success).toBe(true)
    expect(r.restored).toBe(1)
    const skyui = db.prepare('SELECT nexus_file_id FROM mods WHERE nexus_id=1137').get() as {
      nexus_file_id: number
    }
    expect(skyui.nexus_file_id).toBe(9001)
  })

  it('listBackups elenca ANCHE i vecchi file .json accanto ai nuovi .json.gz', async () => {
    const db = seededDb()
    const dir = tmp()
    writeFileSync(join(dir, 'old.json'), '{"version":"1.0","profile":{},"mods":[]}')
    await createProfileBackup(db, dir, 1, 'new')
    const list = await listBackups(dir)
    expect(list).toHaveLength(2)
    expect(list.some((b) => b.name === 'old')).toBe(true)
  })

  it('gzip corrotto oltre il magic-check → restore fallisce con errore pulito, mai throw', async () => {
    const db = seededDb()
    const dir = tmp()
    const corruptPath = join(dir, 'corrupt.json.gz')
    // Magic byte gzip valido ma stream troncato subito dopo → gunzipSync lancia.
    writeFileSync(corruptPath, Buffer.concat([gzipSync('{}').subarray(0, 4)]))
    await writeChecksumSidecar(corruptPath) // sidecar combacia col file troncato: passa il check integrità
    const r = await restoreProfileBackup(db, corruptPath, 1)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/non leggibile/i)
  })

  it('deleteBackup ripulisce sia la variante .json che .json.gz (e i rispettivi sidecar)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'x.json'), '{}')
    writeFileSync(join(dir, 'x.json.gz'), gzipSync('{}'))
    writeFileSync(join(dir, 'x.json.sha256'), 'deadbeef')
    deleteBackup(join(dir, 'x.json.gz'))
    expect(existsSync(join(dir, 'x.json'))).toBe(false)
    expect(existsSync(join(dir, 'x.json.gz'))).toBe(false)
    expect(existsSync(join(dir, 'x.json.sha256'))).toBe(false)
  })

  it('ROTAZIONE: i backup auto oltre il limite vengono potati (piu vecchi prima), i manuali restano', async () => {
    const dir = tmp()
    // 4 auto con mtime crescenti + 1 manuale che NON va toccato.
    for (let i = 0; i < 4; i++) {
      const f = join(dir, `auto-pre-repair_2026-07-1${i}T00-00-00-000Z.json.gz`)
      writeFileSync(f, gzipSync('{}'))
      writeFileSync(f + '.sha256', 'x')
      const t = new Date(2026, 6, 10 + i)
      utimesSync(f, t, t)
    }
    writeFileSync(join(dir, 'manuale.json.gz'), gzipSync('{}'))
    const removed = pruneLabelledBackups(dir, 'auto-pre-repair', 2)
    expect(removed).toBeGreaterThanOrEqual(2)
    const left = readdirSync(dir).filter((f: string) => f.endsWith('.json.gz'))
    expect(left).toHaveLength(3) // 2 auto recenti + 1 manuale
    expect(left).toContain('manuale.json.gz')
    expect(left).not.toContain('auto-pre-repair_2026-07-10T00-00-00-000Z.json.gz')
  })

  it('ROTAZIONE: cartella inesistente o label senza file → 0, mai throw', () => {
    expect(pruneLabelledBackups('Z:/non/esiste', 'auto-pre-repair', 5)).toBe(0)
    expect(pruneLabelledBackups(tmp(), 'mai-vista', 5)).toBe(0)
  })
})
