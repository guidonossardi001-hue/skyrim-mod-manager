import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// installManager imports 'electron' (ipcMain/BrowserWindow) and ./logger (app).
// Stub the whole module so the queue/DB/event adapter can be unit-tested in Node.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => tmpdir() },
}))

import { ipcMain } from 'electron'
import { type SqliteDb, applyPragmas } from './db/sqlite'
import { openTestDb } from './db/openTestDb'
import { initInstallManager } from './installManager'
import type { InstallerService, InstallResult, InstallProgress } from './install/installer'

function testDb(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, is_installed INTEGER DEFAULT 0,
      install_path TEXT, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, nexus_id INTEGER,
      file_id INTEGER, name TEXT NOT NULL, file_path TEXT, status TEXT DEFAULT 'pending', error TEXT);
    CREATE TABLE delta_changeset (id INTEGER PRIMARY KEY AUTOINCREMENT, download_id INTEGER, to_file_hash TEXT);
  `)
  return db
}

/** A fake InstallerService whose installMod is a spy returning a scripted result. */
function fakeInstaller(impl?: (args: unknown[]) => Promise<InstallResult> | InstallResult) {
  const calls: unknown[][] = []
  const installMod = vi.fn(async (...args: unknown[]) => {
    calls.push(args)
    const a = args as [number, number | null, string | null, string, Record<string, unknown>]
    if (impl) return impl(args)
    return {
      success: true,
      nexusId: a[0],
      modPath: `/mods/${(a[4]?.modName as string) ?? 'x'}`,
      strategy: 'recipe',
      recipeSource: 'exact',
      filesDeployed: 3,
      method: '7za',
    } as InstallResult
  })
  return { service: { installMod } as unknown as InstallerService, installMod, calls }
}

let dir: string
let archive: string
let db: SqliteDb
let sent: { ch: string; payload: Record<string, unknown> }[]
const win = () => ({ webContents: { send: (ch: string, payload: Record<string, unknown>) => sent.push({ ch, payload }) } }) as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smm-im-'))
  archive = join(dir, 'a.bin')
  writeFileSync(archive, 'bytes')
  db = testDb()
  sent = []
  vi.clearAllMocks()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const seedDownload = (over: Partial<{ mod_id: number; nexus_id: number; file_id: number; file_path: string }> = {}) => {
  const r = db
    .prepare('INSERT INTO downloads (mod_id, nexus_id, file_id, name, file_path, status) VALUES (?,?,?,?,?,?)')
    .run(over.mod_id ?? null, over.nexus_id ?? 1234, over.file_id ?? 55, 'Cool Mod', over.file_path ?? archive, 'pending')
  return Number(r.lastInsertRowid)
}

describe('installManager.runInstall (delegates to InstallerService)', () => {
  it('success: delegates with resolved identity, updates DB + mods, emits complete, fires hook', async () => {
    const modId = Number(db.prepare('INSERT INTO mods (is_installed) VALUES (0)').run().lastInsertRowid)
    const id = seedDownload({ mod_id: modId })
    db.prepare('INSERT INTO delta_changeset (download_id, to_file_hash) VALUES (?,?)').run(id, 'abc123')
    const { service, installMod, calls } = fakeInstaller()
    const onComplete = vi.fn()
    const mgr = initInstallManager(db as never, win, service, { onComplete })

    const res = await mgr.runInstall(id)
    expect(res.success).toBe(true)
    // identity resolved from the download row + delta hash
    expect(installMod).toHaveBeenCalledTimes(1)
    const [nexusId, fileId, fileHash, archivePath, opts] = calls[0] as [number, number, string, string, Record<string, unknown>]
    expect(nexusId).toBe(1234)
    expect(fileId).toBe(55)
    expect(fileHash).toBe('abc123')
    expect(archivePath).toBe(archive)
    expect(opts.force).toBe(true)
    // Folder namespaced by the stable nexus_id so same-name mods can't collide.
    expect(opts.modName).toBe('1234-Cool Mod')
    // DB transitions
    expect((db.prepare('SELECT status FROM downloads WHERE id=?').get(id) as { status: string }).status).toBe('completed')
    const mod = db.prepare('SELECT is_installed, install_path FROM mods WHERE id=?').get(modId) as { is_installed: number; install_path: string }
    expect(mod.is_installed).toBe(1)
    expect(mod.install_path).toBe('/mods/1234-Cool Mod')
    // event + hook
    expect(sent.some((s) => s.ch === 'install:complete')).toBe(true)
    expect(onComplete).toHaveBeenCalledWith(id)
  })

  it('failure: records failed status with errorKind, emits install:error, fires onError', async () => {
    const id = seedDownload()
    const { service } = fakeInstaller(() => ({ success: false, nexusId: 1234, errorKind: 'recipe', error: 'nessun file' }))
    const onError = vi.fn()
    const mgr = initInstallManager(db as never, win, service, { onError })

    const res = await mgr.runInstall(id)
    expect(res.success).toBe(false)
    const row = db.prepare('SELECT status, error FROM downloads WHERE id=?').get(id) as { status: string; error: string }
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/\[recipe\]/)
    const err = sent.find((s) => s.ch === 'install:error')
    expect(err?.payload.errorKind).toBe('recipe')
    expect(onError).toHaveBeenCalled()
  })

  it('forwards installer progress to install:progress', async () => {
    const id = seedDownload()
    const { service } = fakeInstaller((args) => {
      const opts = (args as unknown[])[4] as { onProgress?: (p: InstallProgress) => void }
      opts.onProgress?.({ nexusId: 1234, stage: 'extracting', percent: 50 })
      return { success: true, nexusId: 1234, modPath: '/mods/x' }
    })
    const mgr = initInstallManager(db as never, win, service)
    await mgr.runInstall(id)
    const p = sent.find((s) => s.ch === 'install:progress')
    expect(p?.payload).toMatchObject({ id, modName: 'Cool Mod', stage: 'extracting', percent: 50 })
  })

  it('missing download row → not-found, no throw', async () => {
    const { service } = fakeInstaller()
    const mgr = initInstallManager(db as never, win, service)
    const res = await mgr.runInstall(9999)
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('not-found')
  })

  it('missing archive file → marks the download failed with not-found', async () => {
    const id = seedDownload({ file_path: join(dir, 'gone.bin') })
    const { service, installMod } = fakeInstaller()
    const mgr = initInstallManager(db as never, win, service)
    const res = await mgr.runInstall(id)
    expect(res.errorKind).toBe('not-found')
    expect(installMod).not.toHaveBeenCalled() // never reaches the installer
    expect((db.prepare('SELECT status FROM downloads WHERE id=?').get(id) as { status: string }).status).toBe('failed')
  })

  it('install:run IPC handler is a no-throw boundary (installer throw → db result)', async () => {
    const id = seedDownload()
    const { service } = fakeInstaller(() => {
      throw new Error('boom low-level')
    })
    initInstallManager(db as never, win, service)
    // grab the handler registered on the mocked ipcMain
    const handleMock = ipcMain.handle as unknown as { mock: { calls: [string, (e: unknown, ...a: unknown[]) => unknown][] } }
    const entry = handleMock.mock.calls.find((c) => c[0] === 'install:run')
    expect(entry).toBeTruthy()
    const result = (await entry![1]({}, id)) as InstallResult
    expect(result.success).toBe(false)
    expect(result.errorKind).toBe('db')
  })

  it('carries deploy_category/resolution_weight from the catalog onto the installed mod (v8 schema)', async () => {
    // Full v8 schema: mods + modlist_catalog both have the conflict-resolution columns.
    const d = openTestDb()
    applyPragmas(d)
    d.exec(`
      CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, is_installed INTEGER DEFAULT 0,
        install_path TEXT, updated_at TEXT, deploy_category TEXT, resolution_weight INTEGER);
      CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, nexus_id INTEGER,
        file_id INTEGER, name TEXT NOT NULL, file_path TEXT, status TEXT DEFAULT 'pending', error TEXT);
      CREATE TABLE delta_changeset (id INTEGER PRIMARY KEY AUTOINCREMENT, download_id INTEGER, to_file_hash TEXT);
      CREATE TABLE modlist_catalog (nexus_id INTEGER, name TEXT, deploy_category TEXT, resolution_weight INTEGER);
    `)
    d.prepare(
      'INSERT INTO modlist_catalog (nexus_id, name, deploy_category, resolution_weight) VALUES (?,?,?,?)',
    ).run(4242, 'HD Textures', 'texture', 4000)
    const modId = Number(d.prepare('INSERT INTO mods (is_installed) VALUES (0)').run().lastInsertRowid)
    const dlId = Number(
      d
        .prepare(
          'INSERT INTO downloads (mod_id, nexus_id, file_id, name, file_path, status) VALUES (?,?,?,?,?,?)',
        )
        .run(modId, 4242, 7, 'HD Textures', archive, 'pending').lastInsertRowid,
    )

    const { service } = fakeInstaller()
    const mgr = initInstallManager(d as never, win, service)
    const res = await mgr.runInstall(dlId)
    expect(res.success).toBe(true)

    const mod = d
      .prepare('SELECT is_installed AS i, deploy_category AS c, resolution_weight AS w FROM mods WHERE id=?')
      .get(modId) as { i: number; c: string; w: number }
    expect(mod.i).toBe(1)
    expect(mod.c).toBe('texture') // ← ingested from the signed catalog at install time
    expect(mod.w).toBe(4000)
  })
})
