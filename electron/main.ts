import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, safeStorage } from 'electron'
import { join, resolve, dirname } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { spawn } from 'child_process'
import Store from 'electron-store'
import Database from 'better-sqlite3'
import axios from 'axios'
import { initDownloadManager } from './downloadManager'
import { initInstallManager } from './installManager'
import { initBackupManager } from './backupManager'
import { initWabbajack } from './wabbajack'
import { applyPragmas, integrityCheck, type SqliteDb } from './db/sqlite'
import { runMigrations } from './db/migrations'
import { setSecret, getSecret, hasSecret, type SecretCrypto } from './db/secrets'
import { initDeltaEngine, onDeltaDownloadComplete, onDeltaDownloadFailed } from './delta/engine'
import { recoverOnStartup } from './delta/journal'
import { createNexusProvider } from './nexus'
import { parseNxmUrl, findNxmUrl, createNxmDownload } from './nexus/nxm'
import { scanVortexMods, buildCatalog, defaultVortexModsRoot, type VortexScan } from './vortex/scan'
import { detectSteamEnv } from './steam/detect'
import { runPreflight, executeLaunch } from './launch/preflight'
import { runCompatReport } from './launch/compat'
import { detect7zPath, parse7zVersion, looksLike7z } from './install/sevenZip'
import {
  planStockGame,
  createStockGameAsync,
  defaultStockGameDir,
  type StockGameProgress,
} from './install/stockGame'
import {
  runMassSync,
  stockGameModsDir,
  modDestDir,
  diskPreflight,
  type MassSyncDeps,
  type SyncMod,
  type SyncProgress,
} from './sync/massSync'
import { getFreeSpace } from './install/diskSpace'
import { detectPandora, pandoraRoots, realFsProbe } from './tools/pandora'
import { autoDetectPaths, type DetectedPaths } from './tools/autoDetect'
import { streamToFile, type HttpGet } from './install/downloadStream'
import { resolveDownloadLink, type HttpGetJson } from './nexus/downloadLink'
import { extractArchive } from './install/extract'
import { bundled7zaPath, resolveRar7z } from './install/sevenZip'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { logger } from './logger'

const isDev = process.env.NODE_ENV === 'development'
const store = new Store()

// Last-resort diagnostics: an uncaught error in the main process must never die
// silently — production issues become diagnosable from userData/logs.
process.on('uncaughtException', (err) => {
  logger.error('main', `uncaughtException: ${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason) => {
  logger.error(
    'main',
    `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  )
})

let mainWindow: BrowserWindow | null = null
let db: Database.Database | null = null
let downloadQueue: { enqueue: (id: number) => void; processPending: () => { queued: number } } | null = null

// ─── Column whitelists ──────────────────────────────────────────────────────
// Mods/profiles/downloads writes build SQL from object keys. We never interpolate
// an unvetted key as a column name: only keys present in these sets are accepted,
// everything else is dropped. Prevents broken queries and SQL-identifier injection.
const MOD_COLUMNS = new Set([
  'profile_id',
  'nexus_id',
  'name',
  'version',
  'author',
  'category',
  'description',
  'file_size',
  'install_path',
  'is_enabled',
  'is_installed',
  'load_order',
  'priority',
  'tags',
  'conflicts',
  'requires',
  'translation_it',
  'nexus_url',
  'thumbnail_url',
  'nexus_file_id',
  'file_hash',
])
const PROFILE_COLUMNS = new Set(['name', 'description', 'game_path', 'mo2_path'])
const DOWNLOAD_COLUMNS = new Set([
  'mod_id',
  'profile_id',
  'nexus_id',
  'file_id',
  'name',
  'url',
  'file_path',
  'total_size',
  'downloaded_size',
  'status',
  'error',
])

function pickColumns(data: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (allowed.has(k)) out[k] = v
  }
  return out
}

// ─── Database init ────────────────────────────────────────────────────────────
function initDatabase() {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'skyrim-manager.db')
  db = new Database(dbPath)

  // Durability/integrity/concurrency pragmas BEFORE any write (A3/A4).
  applyPragmas(db as unknown as SqliteDb)

  // Detect a corrupt database up front (C2). If corrupt, the most recent
  // pre-delta VACUUM INTO snapshot is the recovery point (see docs/DELTA-UPDATES-v2).
  if (!integrityCheck(db as unknown as SqliteDb)) {
    logger.error('db', 'integrity_check FALLITO — database potenzialmente corrotto')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      game_path TEXT,
      mo2_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      nexus_id INTEGER,
      name TEXT NOT NULL,
      version TEXT,
      author TEXT,
      category TEXT,
      description TEXT,
      file_size INTEGER DEFAULT 0,
      install_path TEXT,
      is_enabled INTEGER DEFAULT 1,
      is_installed INTEGER DEFAULT 0,
      load_order INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      conflicts TEXT DEFAULT '[]',
      requires TEXT DEFAULT '[]',
      translation_it INTEGER DEFAULT 0,
      nexus_url TEXT,
      thumbnail_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id)
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mod_id INTEGER,
      profile_id INTEGER NOT NULL,
      nexus_id INTEGER,
      file_id INTEGER,
      name TEXT NOT NULL,
      url TEXT,
      file_path TEXT,
      total_size INTEGER DEFAULT 0,
      downloaded_size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (mod_id) REFERENCES mods(id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modlist_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nexus_id INTEGER UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority_order INTEGER DEFAULT 999,
      required INTEGER DEFAULT 0,
      description TEXT,
      author TEXT,
      tags TEXT DEFAULT '[]',
      size_mb INTEGER DEFAULT 0,
      has_it_translation INTEGER DEFAULT 0,
      notes TEXT,
      conflicts_with TEXT DEFAULT '[]',
      requires TEXT DEFAULT '[]'
    );
  `)

  // Seed default profile if none exists
  const profileCount = db.prepare('SELECT COUNT(*) as c FROM profiles').get() as { c: number }
  if (profileCount.c === 0) {
    db.prepare(
      `
      INSERT INTO profiles (name, description) VALUES (?, ?)
    `,
    ).run('Anime Fantasy Default', 'Profilo principale - Mix Anime 50% / Fantasy Realistico 50%')
  }

  // Versioned, ordered migrations on top of the baseline (M1) — adds the
  // delta-versioning tables + file-identity columns.
  const mig = runMigrations(db as unknown as SqliteDb)
  if (mig.applied.length)
    logger.info('db', `migrazioni applicate: ${mig.applied.join(', ')} (schema v${mig.to})`)

  // Move any pre-existing electron-store API key into the encrypted DB table.
  migrateLegacySecrets()
}

// ─── Security hardening ─────────────────────────────────────────────────────
function applySecurityPolicies() {
  // Content-Security-Policy: in dev we must allow Vite's inline/eval HMR + ws;
  // in production we lock down to self. Connections to the Nexus API are allowed.
  const csp = isDev
    ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173 ws://localhost:5173; " +
      "img-src 'self' data: https:; connect-src 'self' http://localhost:5173 ws://localhost:5173 https://api.nexusmods.com https://www.nexusmods.com https://raw.githubusercontent.com"
    : "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
      "font-src 'self' data:; connect-src 'self' https://api.nexusmods.com https://www.nexusmods.com https://raw.githubusercontent.com"

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#050507',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: join(__dirname, '../resources/icons/icon.ico'),
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Never let the renderer navigate away from the app, and route any window.open
  // / target=_blank to the OS browser instead of spawning an in-app BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? 'http://localhost:5173' : 'file://'
    if (!url.startsWith(allowed)) {
      e.preventDefault()
      if (url.startsWith('http')) shell.openExternal(url)
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
}

// Register as the nxm:// protocol client so "Mod Manager Download" links on Nexus
// launch (or hand off to) this app. In dev (unpacked) we must pass execPath + the
// entry script so the relaunch targets Electron correctly; packaged builds register
// the installed exe.
function registerNxmProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2)
      app.setAsDefaultProtocolClient('nxm', process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient('nxm')
  }
}

// nxm:// dispatch: parse → create a pending download (with non-premium key/expires)
// → enqueue into the live pipeline → focus the window. URLs that arrive before the
// DB/queue are ready (cold start) are buffered and flushed after init.
const pendingNxm: string[] = []
function handleNxmUrl(raw: string) {
  if (!db || !downloadQueue) {
    pendingNxm.push(raw)
    return
  }
  const link = parseNxmUrl(raw)
  if (!link) {
    logger.warn('nxm', `URL nxm ignorato (malformato): ${raw}`)
    return
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  try {
    const profileId =
      (store.get('activeProfileId') as number | undefined) ??
      (
        db.prepare('SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1').get() as
          { id: number } | undefined
      )?.id ??
      1
    const id = createNxmDownload(db as unknown as SqliteDb, link, { profileId })
    downloadQueue.enqueue(id)
    logger.info(
      'nxm',
      `download accodato da nxm: mod ${link.modId} file ${link.fileId} (#${id}${link.key ? ', non-premium' : ''})`,
    )
    mainWindow?.webContents.send('nxm:queued', { id, modId: link.modId, fileId: link.fileId })
  } catch (e) {
    logger.error('nxm', `accodamento nxm fallito: ${(e as Error).message}`)
  }
}
function flushPendingNxm() {
  const cold = findNxmUrl(process.argv) // protocol launch on a COLD start
  if (cold) pendingNxm.push(cold)
  for (const u of pendingNxm.splice(0)) handleNxmUrl(u)
}

// Single-instance lock (A4): two processes opening the same SQLite file race and
// can corrupt it. The second instance forwards its nxm:// arg to the primary, which
// focuses and enqueues it — then the second instance exits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerNxmProtocol()
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const url = findNxmUrl(argv)
    if (url) handleNxmUrl(url)
  })
  // macOS delivers protocol URLs via this event rather than argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleNxmUrl(url)
  })
}

app.whenReady().then(() => {
  applySecurityPolicies()
  initDatabase()
  // Crash recovery (A5): reset any update left mid-flight to a re-runnable state.
  // Never advances installed_snapshot — only the gated finalize can do that.
  const rec = recoverOnStartup(db! as unknown as SqliteDb)
  if (rec.resetRows || rec.resetDownloads) {
    logger.info(
      'delta',
      `recovery avvio: ${rec.resetRows} righe changeset, ${rec.resetDownloads} download ripristinati`,
    )
  }
  createWindow()
  // Init subsystems. The install pipeline is wired into the download manager so
  // a completed download automatically extracts and deploys into the mods folder.
  const installManager = initInstallManager(db!, () => mainWindow, store, {
    onComplete: (id) => onDeltaDownloadComplete(db! as unknown as SqliteDb, id),
    onError: (id, err) => onDeltaDownloadFailed(db! as unknown as SqliteDb, id, err),
  })
  downloadQueue = initDownloadManager(db!, () => mainWindow, {
    store,
    // Real Nexus requests read the manually-entered key from the encrypted DB store.
    getApiKey: () => readSecret('nexusApiKey') || undefined,
    onInstall: installManager.runInstall,
  })
  // Resume any downloads left pending from a previous session.
  downloadQueue.processPending()
  // Now that the DB + queue exist, process any nxm:// link that launched us (cold
  // start) or arrived via a second instance during startup.
  flushPendingNxm()
  initBackupManager(db!)
  initWabbajack(db!)
  // Delta/incremental-update engine (signed-manifest ingest, diff, gated apply).
  initDeltaEngine(db! as unknown as SqliteDb, { enqueueDownload: (id) => downloadQueue?.enqueue(id) })

  // Nexus provider — deferred activation. Mock until enabled + a real key; enabled
  // either via the in-app toggle (`nexusEnabled` setting) OR the NEXUS_ENABLED env
  // var. Re-resolved per-call so toggling the flag/key needs no restart.
  const nexusEnabled = (): boolean =>
    process.env.NEXUS_ENABLED === 'true' || store.get('nexusEnabled') === true
  const nexus = () =>
    createNexusProvider(db! as unknown as SqliteDb, {
      enabled: nexusEnabled(),
      apiKey: readSecret('nexusApiKey') || undefined,
    })
  ipcMain.handle('nexus:status', () => {
    const p = nexus()
    return { kind: p.kind, enabled: p.enabled }
  })
  ipcMain.handle('nexus:meta', (_e, modId: number) => nexus().getMod(modId))
  ipcMain.handle('nexus:check-update', (_e, modId: number, version: string | null) =>
    nexus().checkUpdate(modId, version),
  )

  // Steam detection + launch pre-flight (companion mode: read-only, gated launch).
  ipcMain.handle('steam:detect', () => detectSteamEnv())
  ipcMain.handle('launch:preflight', () => runPreflight(db!, store))
  ipcMain.handle('launch:run', () => executeLaunch(db!, store))
  // Compatibility report (runtime/SKSE version + active-profile plugins.txt).
  ipcMain.handle('compat:analyze', () => runCompatReport(db!, store))

  // Pandora detection (PANDORA-REGISTER-01): locate the engine exe, persist its path,
  // and report presence. READ-ONLY — never spawns Pandora, never generates output.
  ipcMain.handle('tools:pandora:path', () => {
    const saved = store.get('pandoraPath') as string | undefined
    const det = detectPandora(pandoraRoots(saved, app.getPath('home')), realFsProbe)
    if (det.exeFound && det.exePath && det.exePath !== saved) store.set('pandoraPath', det.exePath) // register only
    return det
  })

  // ── StockGame builder ──────────────────────────────────────────────────────
  // Creates an ISOLATED vanilla copy of Skyrim SE/AE so the modded setup never
  // touches the real Steam install. READ-ONLY on the source; writes only to the
  // target. Source is auto-detected from Steam but can be overridden in Settings.
  const resolveGameSource = (): string | null =>
    (store.get('stockGameSource') as string | undefined) || detectSteamEnv().skyrim.path
  const resolveStockTarget = (): string =>
    (store.get('stockGamePath') as string | undefined) || defaultStockGameDir(app.getPath('userData'))

  ipcMain.handle('stockgame:detect', () => {
    const source = resolveGameSource()
    const target = resolveStockTarget()
    if (!source || !existsSync(source)) return { source: null, target, plan: null }
    try {
      const plan = planStockGame(source)
      return {
        source,
        target,
        plan: {
          files: plan.files.length,
          totalBytes: plan.totalBytes,
          skippedFiles: plan.skippedFiles,
          skippedBytes: plan.skippedBytes,
        },
      }
    } catch (e) {
      return { source, target, plan: null, error: (e as Error).message }
    }
  })

  ipcMain.handle('stockgame:create', async (_e, opts?: { mode?: 'hardlink' | 'copy' }) => {
    const source = resolveGameSource()
    const target = resolveStockTarget()
    if (!source)
      throw new Error('Installazione Skyrim non rilevata: imposta il percorso del gioco nelle Impostazioni')
    const send = (p: StockGameProgress) => mainWindow?.webContents.send('stockgame:progress', p)
    logger.info('stockgame', `creazione StockGame: ${source} → ${target} (${opts?.mode ?? 'hardlink'})`)
    const result = await createStockGameAsync(
      { sourceGameDir: source, targetDir: target, mode: opts?.mode ?? 'hardlink' },
      send,
    )
    logger.info(
      'stockgame',
      `StockGame pronto: ${result.filesTotal} file (${result.hardlinked} hardlink, ${result.copied} copie), ${(result.bytesTotal / 1024 ** 3).toFixed(1)} GB; saltati ${result.skippedFiles} elementi mod`,
    )
    if (result.missingRequired.length)
      logger.warn('stockgame', `file vanilla mancanti dopo la build: ${result.missingRequired.join(', ')}`)
    return result
  })

  // ── Mass-sync orchestrator (Cabl-01) ────────────────────────────────────────
  // Drives the whole modlist (backup → 4.568 mod) through the tested primitives,
  // writing ONLY inside the isolated StockGame (download cache + StockGame/mods).
  // Gated: runs only on explicit sync:start; Nexus must be enabled with a real key.
  const axiosGet: HttpGet = (url, cfg) => axios.get(url, cfg as never) as never
  const axiosJson: HttpGetJson = (url, cfg) => axios.get(url, cfg as never) as never
  const md5File = (path: string): Promise<string> =>
    new Promise((res, rej) => {
      const h = createHash('md5')
      createReadStream(path)
        .on('data', (d) => h.update(d as Buffer))
        .on('end', () => res(h.digest('hex')))
        .on('error', rej)
    })
  const buildSyncDeps = (): MassSyncDeps => ({
    resolveLink: (modId, fileId) =>
      resolveDownloadLink(axiosJson, { modId, fileId, apiKey: readSecret('nexusApiKey') || undefined }),
    streamDownload: (url, destPath, onProgress, signal) =>
      streamToFile({ url, destPath, http: axiosGet, signal, onProgress }).then((r) => ({ bytes: r.bytes })),
    md5: md5File,
    extract: (archive, destDir, onProgress, signal) =>
      extractArchive(archive, destDir, {
        bundled7zaPath: bundled7zaPath(),
        full7zPath: resolveRar7z(store.get('sevenZipPath') as string | undefined) ?? undefined,
        onProgress,
        signal,
      }).then((r) => ({ method: r.method })),
    exists: existsSync,
    ensureDir: (p) => {
      if (!existsSync(p)) mkdirSync(p, { recursive: true })
    },
    remove: (p) => {
      try {
        if (existsSync(p)) rmSync(p, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
    freeSpace: (p) => getFreeSpace(p),
  })
  const syncFactors = () => ({
    extractionOverhead:
      Number(store.get('extractionOverhead')) > 0 ? Number(store.get('extractionOverhead')) : undefined,
    safetyFactor:
      Number(store.get('diskSafetyFactor')) > 0 ? Number(store.get('diskSafetyFactor')) : undefined,
  })
  // Source of truth: the persisted backup (survives a Vortex wipe); fallback to a live scan.
  const loadSyncMods = (): SyncMod[] => {
    const candidates = [
      store.get('collectionsBackupPath') as string | undefined,
      join(app.getPath('userData'), 'vortex-collections-backup.json'),
      join(process.cwd(), 'data', 'vortex-collections-backup.json'),
    ].filter(Boolean) as string[]
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue
        const b = JSON.parse(readFileSync(p, 'utf8'))
        const arr = (b.deduped ?? []) as Array<{
          modId: number
          fileId: number
          name: string
          md5?: string
          fileSize?: number
        }>
        const mods = arr
          .filter((m) => m.modId && m.fileId)
          .map((m) => ({ modId: m.modId, fileId: m.fileId, name: m.name, md5: m.md5, fileSize: m.fileSize }))
        if (mods.length) {
          logger.info('sync', `sorgente: backup ${p} (${mods.length} mod)`)
          return mods
        }
      } catch {
        /* try next */
      }
    }
    // fallback: live Vortex scan
    const root = (store.get('vortexPath') as string | undefined) || defaultVortexModsRoot()
    if (root && existsSync(root)) {
      const scan = scanVortexMods(root)
      const mods = scan.mods
        .filter((m) => m.fileId)
        .map((m) => ({
          modId: m.modId,
          fileId: m.fileId as number,
          name: m.name,
          md5: m.md5,
          fileSize: m.fileSize,
        }))
      logger.info('sync', `sorgente: scan Vortex (${mods.length} mod)`)
      return mods
    }
    return []
  }

  // Selezione del blocco Run-Prog: senza limit → tutta la lista; con limit → le
  // prossime N mod il cui dir di estrazione non esiste ancora (progressione reale).
  const selectSyncBlock = (all: SyncMod[], stockDir: string, limit?: number): SyncMod[] => {
    if (!limit || limit <= 0) return all
    const modsDir = stockGameModsDir(stockDir)
    return all.filter((m) => !existsSync(modDestDir(modsDir, m))).slice(0, limit)
  }

  let syncAbort: AbortController | null = null
  let syncState: SyncProgress | null = null
  ipcMain.handle('sync:start', (_e, opts?: { concurrency?: number; limit?: number }) => {
    if (syncAbort) return { ok: false, error: 'Sincronizzazione già in corso' }
    if (!nexusEnabled() || !(readSecret('nexusApiKey') || '').trim()) {
      return {
        ok: false,
        error:
          'Nexus non attivo: inserisci la chiave Premium e abilita il download reale nelle Impostazioni.',
      }
    }
    const stockDir = resolveStockTarget()
    const steam = resolveGameSource()
    const all = loadSyncMods()
    if (!all.length) return { ok: false, error: 'Nessun mod da sincronizzare (backup e scan Vortex vuoti).' }
    // Run-Prog: con un limit il blocco è composto dalle prossime N mod NON ancora
    // presenti nello StockGame (non le prime N della lista, che dopo il primo run
    // sarebbero tutte skip). Senza limit: intera lista (lo skip fa da resume).
    const mods = selectSyncBlock(all, stockDir, opts?.limit)
    if (!mods.length) return { ok: false, error: 'Tutte le mod risultano già sincronizzate nello StockGame.' }
    const downloadsDir = join(app.getPath('userData'), 'downloads')
    const concurrency =
      opts?.concurrency ?? Math.max(1, Math.min(8, Number(store.get('downloadThreads')) || 4))
    syncAbort = new AbortController()
    logger.info(
      'sync',
      `avvio mass-sync: ${mods.length} mod → ${stockGameModsDir(stockDir)} (concorrenza ${concurrency})`,
    )
    runMassSync(buildSyncDeps(), {
      mods,
      stockGameDir: stockDir,
      steamGamePath: steam,
      downloadsDir,
      concurrency,
      signal: syncAbort.signal,
      maxRetries: Math.max(0, Math.min(10, Number(store.get('downloadRetries') ?? 3))),
      errorThreshold: Math.max(1, Number(store.get('errorThreshold')) || 50),
      ...syncFactors(),
      onProgress: (s) => {
        syncState = s
        mainWindow?.webContents.send('sync:progress', s)
      },
      onLog: (m) => logger.info('sync', m),
    })
      .then((final) => {
        logger.info(
          'sync',
          `mass-sync terminato: ${final.phase} (ok ${final.modsDone}, skip ${final.modsSkipped}, fail ${final.modsFailed})`,
        )
      })
      .catch((err) => {
        const msg = (err as Error).message
        syncState = {
          phase: 'error',
          modsTotal: mods.length,
          modsDone: 0,
          modsFailed: 0,
          modsSkipped: 0,
          bytesDownloaded: 0,
          bytesTotal: 0,
          throughputMBps: 0,
          etaSeconds: null,
          active: [],
          lastMessage: msg,
        }
        mainWindow?.webContents.send('sync:progress', syncState)
        logger.error('sync', `mass-sync errore: ${msg}`)
      })
      .finally(() => {
        syncAbort = null
      })
    return { ok: true, total: mods.length, stockGameDir: stockDir }
  })
  ipcMain.handle('sync:cancel', () => {
    syncAbort?.abort()
    return { ok: true }
  })
  ipcMain.handle('sync:status', () => syncState)
  // Aggregate disk pre-flight WITHOUT starting the sync — for the Dashboard GO/NO-GO readout.
  // Con un limit valuta lo spazio del SOLO blocco pianificato (Run-Prog), così la
  // card riflette il run che verrà davvero lanciato, non l'intera modlist.
  ipcMain.handle('sync:preflight', async (_e, opts?: { limit?: number }) => {
    const stockDir = resolveStockTarget()
    const all = loadSyncMods()
    const mods = selectSyncBlock(all, stockDir, opts?.limit)
    const pf = await diskPreflight(
      { exists: existsSync, freeSpace: getFreeSpace },
      { mods, stockGameDir: stockDir, ...syncFactors() },
    )
    return { ...pf, stockGameDir: stockDir, modsTotal: all.length, modsSelected: mods.length }
  })

  // ── Vortex importer ────────────────────────────────────────────────────────
  // READ-ONLY scan of an existing Vortex Skyrim SE staging folder: parses the
  // collection.json files (authoritative Nexus modId/fileId) + folder names, dedups.
  const resolveVortexRoot = (): string | null =>
    (store.get('vortexPath') as string | undefined) || defaultVortexModsRoot()
  const runVortexScan = (): VortexScan => {
    const root = resolveVortexRoot()
    return root
      ? scanVortexMods(root)
      : {
          collections: [],
          mods: [],
          folderCount: 0,
          fromCollections: 0,
          fromFolders: 0,
          duplicatesRemoved: 0,
          totalBytes: 0,
        }
  }
  // Auto-run on startup — strictly read-only (no download, no game changes). The
  // destructive pipeline (download → extract → Pandora) stays behind explicit consent.
  // Deferred: the scan walks hundreds of mod folders synchronously and must not
  // delay the first paint of the window.
  setImmediate(() => {
    try {
      const vx = runVortexScan()
      if (vx.mods.length)
        logger.info(
          'vortex',
          `scansione avvio: ${vx.mods.length} mod uniche da ${vx.collections.length} collezioni (${vx.duplicatesRemoved} doppioni rimossi)`,
        )
    } catch (e) {
      logger.warn('vortex', `scan avvio fallito: ${(e as Error).message}`)
    }
  })

  // Auto-detection all'avvio: popola SOLO i percorsi non ancora impostati (silent-fallback,
  // non blocca l'app). Deferita per non ritardare la comparsa della finestra.
  setImmediate(() => {
    try {
      const applied = applyDetectedPaths(autoDetectPaths(), { fillEmptyOnly: true })
      const keys = Object.keys(applied)
      if (keys.length) logger.info('autodetect', `avvio: impostati automaticamente ${keys.join(', ')}`)
    } catch (e) {
      logger.warn('autodetect', `avvio fallito: ${(e as Error).message}`)
    }
  })

  ipcMain.handle('vortex:scan', () => runVortexScan())
  ipcMain.handle('vortex:build-catalog', () => {
    const scan = runVortexScan()
    const catalog = buildCatalog(scan)
    const out = join(app.getPath('userData'), 'vortex-catalog.json')
    writeFileSync(out, JSON.stringify(catalog, null, 2))
    logger.info('vortex', `catalog.json generato: ${catalog.total} mod → ${out}`)
    return { path: out, total: catalog.total, collections: catalog.collections }
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized())

// ─── Settings IPC ─────────────────────────────────────────────────────────────
// Secrets (the Nexus API key) are encrypted at rest with the OS keychain via
// safeStorage instead of being persisted in plaintext. A marker prefix lets us
// distinguish encrypted values and stay backward compatible with old plaintext.
// The PLAINTEXT never crosses the IPC boundary: the renderer only ever sees
// SECRET_MASK (or ''), and every Nexus handler reads the key main-side.
const SECRET_KEYS = new Set(['nexusApiKey'])
const ENC_PREFIX = 'enc:v1:'
const SECRET_MASK = '********'

function encryptSecret(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value
  if (!safeStorage.isEncryptionAvailable()) {
    // Fail-closed: refusing to persist beats silently writing the key in chiaro.
    throw new Error('Cifratura di sistema non disponibile (safeStorage): chiave non salvata')
  }
  return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return '' // corrupt/undecryptable — surface as empty rather than leaking ciphertext
  }
}

// Secrets now live in the SQLite `app_secrets` table (encrypted via safeStorage),
// so the key persists alongside the rest of the app data. The crypto adapter reuses
// the existing encrypt/decrypt so stored values stay ciphertext, never plaintext.
const secretCrypto: SecretCrypto = {
  encrypt: (plain) => String(encryptSecret(plain)),
  decrypt: (stored) => String(decryptSecret(stored)),
}

/** Read a SECRET_KEY: from the DB first, falling back to (and migrating) any legacy store value. */
function readSecret(key: string): string {
  if (db) {
    const fromDb = getSecret(db as unknown as SqliteDb, key, secretCrypto)
    if (fromDb) return fromDb
  }
  const legacy = decryptSecret(store.get(key))
  return typeof legacy === 'string' ? legacy : ''
}

/** One-time move of any legacy electron-store secret into the encrypted DB table. */
function migrateLegacySecrets() {
  if (!db) return
  for (const k of SECRET_KEYS) {
    if (!hasSecret(db as unknown as SqliteDb, k) && store.has(k)) {
      const plain = decryptSecret(store.get(k))
      if (typeof plain === 'string' && plain) setSecret(db as unknown as SqliteDb, k, plain, secretCrypto)
      store.delete(k as never)
    }
  }
}

ipcMain.handle('settings:get', (_e, key: string) => {
  if (SECRET_KEYS.has(key)) return readSecret(key) ? SECRET_MASK : ''
  return store.get(key)
})
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  if (SECRET_KEYS.has(key)) {
    if (value === SECRET_MASK) return // masked echo from the renderer: not a new value
    if (db) setSecret(db as unknown as SqliteDb, key, typeof value === 'string' ? value : '', secretCrypto)
    else store.set(key, encryptSecret(value)) // pre-DB fallback (should not happen at runtime)
    return
  }
  store.set(key, value)
})
ipcMain.handle('settings:get-all', () => {
  const all = { ...store.store } as Record<string, unknown>
  for (const k of SECRET_KEYS) all[k] = readSecret(k) ? SECRET_MASK : ''
  return all
})

// Persist detected paths into the settings store. fillEmptyOnly=true (startup) never
// clobbers a value the user already set; false (explicit "Rileva Automaticamente") writes
// every successfully-found path. Returns the subset actually applied.
function applyDetectedPaths(det: DetectedPaths, opts: { fillEmptyOnly: boolean }): DetectedPaths {
  const applied: DetectedPaths = {}
  for (const [k, v] of Object.entries(det)) {
    if (!v) continue // silent fallback: skip not-found
    if (opts.fillEmptyOnly) {
      const cur = store.get(k)
      if (cur && String(cur).trim()) continue
    }
    store.set(k, v)
    ;(applied as Record<string, string>)[k] = v
  }
  return applied
}
// Advanced auto-detection (Steam registry game path + tool scan). READ-ONLY probe;
// writes only non-secret path settings. Never throws → the UI/startup are never blocked.
ipcMain.handle('settings:auto-detect', () => {
  try {
    const det = autoDetectPaths()
    const applied = applyDetectedPaths(det, { fillEmptyOnly: false })
    logger.info('autodetect', `rilevati/salvati: ${Object.keys(applied).join(', ') || 'nessuno'}`)
    return { ok: true, detected: det, applied }
  } catch (e) {
    logger.warn('autodetect', `fallita: ${(e as Error).message}`)
    return { ok: false, detected: {}, applied: {}, error: (e as Error).message }
  }
})

// ─── Profile IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('profiles:list', () => {
  return db!.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all()
})

ipcMain.handle('profiles:create', (_e, data: { name: string; description?: string }) => {
  const result = db!
    .prepare('INSERT INTO profiles (name, description) VALUES (?, ?)')
    .run(data.name, data.description ?? '')
  return db!.prepare('SELECT * FROM profiles WHERE id = ?').get(result.lastInsertRowid)
})

ipcMain.handle('profiles:update', (_e, id: number, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, PROFILE_COLUMNS)
  if (Object.keys(data).length === 0) return db!.prepare('SELECT * FROM profiles WHERE id = ?').get(id)
  const fields = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ')
  db!
    .prepare(`UPDATE profiles SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(data), id)
  return db!.prepare('SELECT * FROM profiles WHERE id = ?').get(id)
})

ipcMain.handle('profiles:delete', (_e, id: number) => {
  // FK-safe order (foreign_keys=ON): remove children without ON DELETE CASCADE
  // first (downloads → mods), then the profile (installed_snapshot / delta_changeset
  // cascade automatically).
  const tx = db!.transaction((profileId: number) => {
    db!.prepare('DELETE FROM downloads WHERE profile_id = ?').run(profileId)
    db!.prepare('DELETE FROM mods WHERE profile_id = ?').run(profileId)
    db!.prepare('DELETE FROM profiles WHERE id = ?').run(profileId)
  })
  tx(id)
})

// ─── Mods IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('mods:list', (_e, profileId: number) => {
  return db!
    .prepare(
      `
    SELECT * FROM mods WHERE profile_id = ? ORDER BY priority ASC, load_order ASC
  `,
    )
    .all(profileId)
})

ipcMain.handle('mods:add', (_e, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, MOD_COLUMNS)
  if (!data.name) throw new Error('mods:add richiede almeno un campo "name"')
  const cols = Object.keys(data).join(', ')
  const placeholders = Object.keys(data)
    .map(() => '?')
    .join(', ')
  const result = db!
    .prepare(`INSERT INTO mods (${cols}) VALUES (${placeholders})`)
    .run(...Object.values(data))
  return db!.prepare('SELECT * FROM mods WHERE id = ?').get(result.lastInsertRowid)
})

// Bulk insert in UNA transazione: l'import di un modlist.txt da migliaia di righe
// non paga più un round-trip IPC + una transazione implicita per riga.
ipcMain.handle('mods:add-many', (_e, rawRows: Record<string, unknown>[]) => {
  const rows = rawRows.map((r) => pickColumns(r, MOD_COLUMNS)).filter((r) => r.name)
  if (!rows.length) return { inserted: 0 }
  const tx = db!.transaction((items: Record<string, unknown>[]) => {
    for (const data of items) {
      const cols = Object.keys(data).join(', ')
      const placeholders = Object.keys(data)
        .map(() => '?')
        .join(', ')
      db!.prepare(`INSERT INTO mods (${cols}) VALUES (${placeholders})`).run(...Object.values(data))
    }
  })
  tx(rows)
  return { inserted: rows.length }
})

ipcMain.handle('mods:update', (_e, id: number, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, MOD_COLUMNS)
  if (Object.keys(data).length === 0) return db!.prepare('SELECT * FROM mods WHERE id = ?').get(id)
  const fields = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ')
  db!
    .prepare(`UPDATE mods SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(data), id)
  return db!.prepare('SELECT * FROM mods WHERE id = ?').get(id)
})

ipcMain.handle('mods:delete', (_e, id: number) => {
  // FK-safe: downloads reference mods(id) without cascade — remove them first.
  const tx = db!.transaction((modId: number) => {
    db!.prepare('DELETE FROM downloads WHERE mod_id = ?').run(modId)
    db!.prepare('DELETE FROM mods WHERE id = ?').run(modId)
  })
  tx(id)
})

ipcMain.handle('mods:reorder', (_e, profileId: number, orderedIds: number[]) => {
  const update = db!.prepare('UPDATE mods SET priority = ? WHERE id = ? AND profile_id = ?')
  const transaction = db!.transaction((ids: number[]) => {
    ids.forEach((id, idx) => update.run(idx, id, profileId))
  })
  transaction(orderedIds)
})

// ─── Catalog IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('catalog:list', (_e, filter?: { category?: string; search?: string }) => {
  let query = 'SELECT * FROM modlist_catalog'
  const params: unknown[] = []
  const conditions: string[] = []
  if (filter?.category) {
    conditions.push('category = ?')
    params.push(filter.category)
  }
  if (filter?.search) {
    conditions.push('(name LIKE ? OR description LIKE ? OR author LIKE ?)')
    const s = `%${filter.search}%`
    params.push(s, s, s)
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ')
  query += ' ORDER BY priority_order ASC, name ASC'
  return db!.prepare(query).all(...params)
})

ipcMain.handle('catalog:seed', (_e, mods: unknown[]) => {
  const insert = db!.prepare(`
    INSERT OR REPLACE INTO modlist_catalog
    (nexus_id, name, category, subcategory, priority_order, required, description, author, tags, size_mb, has_it_translation, notes, conflicts_with, requires)
    VALUES (@nexus_id, @name, @category, @subcategory, @priority_order, @required, @description, @author, @tags, @size_mb, @has_it_translation, @notes, @conflicts_with, @requires)
  `)
  const insertMany = db!.transaction((rows: unknown[]) => {
    for (const row of rows) insert.run(row as Record<string, unknown>)
  })
  insertMany(mods)
  return { inserted: mods.length }
})

// ─── Downloads IPC ────────────────────────────────────────────────────────────
ipcMain.handle('downloads:list', (_e, profileId: number) => {
  return db!.prepare('SELECT * FROM downloads WHERE profile_id = ? ORDER BY created_at DESC').all(profileId)
})

ipcMain.handle('downloads:add', (_e, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, DOWNLOAD_COLUMNS)
  if (!data.name) throw new Error('downloads:add richiede almeno un campo "name"')
  const cols = Object.keys(data).join(', ')
  const placeholders = Object.keys(data)
    .map(() => '?')
    .join(', ')
  const result = db!
    .prepare(`INSERT INTO downloads (${cols}) VALUES (${placeholders})`)
    .run(...Object.values(data))
  const id = Number(result.lastInsertRowid)
  // Hand the new download to the queue unless it was inserted already-completed.
  if (data.status === undefined || data.status === 'pending') downloadQueue?.enqueue(id)
  return id
})

ipcMain.handle(
  'downloads:update-status',
  (_e, id: number, status: string, rawExtra?: Record<string, unknown>) => {
    const extra = rawExtra ? pickColumns(rawExtra, DOWNLOAD_COLUMNS) : undefined
    if (extra && Object.keys(extra).length > 0) {
      const fields = ['status', ...Object.keys(extra)].map((k) => `${k} = ?`).join(', ')
      db!.prepare(`UPDATE downloads SET ${fields} WHERE id = ?`).run(status, ...Object.values(extra), id)
    } else {
      db!.prepare('UPDATE downloads SET status = ? WHERE id = ?').run(status, id)
    }
  },
)

// ─── Nexus API IPC ────────────────────────────────────────────────────────────
// The API key is ALWAYS read from the main-side secret store: the renderer never
// holds the real key (it only sees SECRET_MASK), so a compromised renderer cannot
// exfiltrate it and the legacy `apiKey` parameter from old callers is ignored.
ipcMain.handle('nexus:search', async (_e, query: string) => {
  try {
    const res = await axios.get('https://www.nexusmods.com/Core/Libs/Common/Widgets/ModList', {
      params: { game_id: 1704, terms: query, from: 0 },
      headers: { apikey: readSecret('nexusApiKey'), 'User-Agent': 'SkyrimAEModManager/1.0' },
    })
    return { success: true, data: res.data }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
})

ipcMain.handle('nexus:get-mod', async (_e, nexusId: number) => {
  try {
    const res = await axios.get(
      `https://api.nexusmods.com/v1/games/skyrimspecialedition/mods/${nexusId}.json`,
      {
        headers: { apikey: readSecret('nexusApiKey'), 'User-Agent': 'SkyrimAEModManager/1.0' },
      },
    )
    return { success: true, data: res.data }
  } catch (err: unknown) {
    return { success: false, error: (err as Error).message }
  }
})

// Validation may receive a candidate key just typed in Settings (not yet saved);
// the masked echo (or an empty value) means "validate the stored key".
ipcMain.handle('nexus:validate-key', async (_e, apiKey?: string) => {
  const key = apiKey && apiKey !== SECRET_MASK ? apiKey : readSecret('nexusApiKey')
  if (!key) return { success: false }
  try {
    const res = await axios.get('https://api.nexusmods.com/v1/users/validate.json', {
      headers: { apikey: key, 'User-Agent': 'SkyrimAEModManager/1.0' },
    })
    return { success: true, data: res.data }
  } catch {
    return { success: false }
  }
})

// ─── File system IPC ──────────────────────────────────────────────────────────
ipcMain.handle('fs:pick-directory', async (_e, title?: string) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: title ?? 'Seleziona cartella',
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('fs:pick-file', async (_e, title?: string, filters?: Electron.FileFilter[]) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: title ?? 'Seleziona file',
    properties: ['openFile'],
    filters: filters ?? [],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('fs:exists', (_e, path: string) => existsSync(path))

// Async + one stat per entry via Dirent: a big directory no longer freezes the
// main process the way the old readdirSync/statSync-per-file version did.
ipcMain.handle('fs:read-dir', async (_e, path: string) => {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return await Promise.all(
      entries.map(async (d) => {
        const full = join(path, d.name)
        const size = d.isDirectory()
          ? 0
          : await stat(full)
              .then((s) => s.size)
              .catch(() => 0)
        return { name: d.name, path: full, isDirectory: d.isDirectory(), size }
      }),
    )
  } catch {
    return []
  }
})

ipcMain.handle('fs:open-path', (_e, path: string) => shell.openPath(path))
// Only web URLs may leave the app: anything else (file:, smb:, custom schemes able
// to trigger local handlers) is refused.
ipcMain.handle('fs:open-external', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
  logger.warn('security', `fs:open-external rifiutato (schema non consentito): ${String(url).slice(0, 120)}`)
  return Promise.resolve()
})

// ─── External tools IPC ───────────────────────────────────────────────────────
// The renderer chooses WHICH tool to launch, never WHAT executable runs: every
// path is resolved main-side from the settings store (populated via the trusted
// pickFile dialog / auto-detect). A compromised renderer cannot spawn arbitrary
// binaries by passing a path over IPC.
const toolPath = (key: string): string | null => {
  const p = store.get(key)
  return typeof p === 'string' && p && existsSync(p) ? p : null
}
const launchTool = (exe: string | null, args: string[] = [], opts: { cwd?: string } = {}) =>
  new Promise((resolve) => {
    if (!exe) {
      resolve({ success: false, error: 'Percorso non configurato: impostalo nelle Impostazioni' })
      return
    }
    const proc = spawn(exe, args, { cwd: opts.cwd ?? dirname(exe), windowsHide: false })
    proc.on('close', (code) => resolve({ success: code === 0, code }))
    proc.on('error', (e) => resolve({ success: false, error: e.message }))
  })

ipcMain.handle('tools:launch-mo2', () => launchTool(toolPath('mo2Path')))
ipcMain.handle('tools:launch-loot', () => {
  const gamePath = store.get('gamePath')
  const args =
    typeof gamePath === 'string' && gamePath
      ? ['--game=SkyrimSE', `--game-path=${gamePath}`]
      : ['--game=SkyrimSE']
  return launchTool(toolPath('lootPath'), args)
})
ipcMain.handle('tools:launch-sseedit', () => launchTool(toolPath('sseeditPath')))
ipcMain.handle('tools:launch-dyndolod', () => launchTool(toolPath('dyndolodPath')))

// Pandora Behaviour Engine — the single animation/behaviour manager. Launched as an
// EXPLICIT step (it regenerates the game's behaviour files); never auto-run silently.
ipcMain.handle('tools:launch-pandora', () => launchTool(toolPath('pandoraPath')))

// Validate / auto-detect 7-Zip: required for .7z/.rar (most heavy mods). Resolves the
// configured path or a known install location, then runs the binary to confirm it is
// actually 7-Zip and read its version. Persistence is via the normal settings store.
ipcMain.handle('tools:validate-7z', (_e, configured?: string) => {
  const path = detect7zPath(existsSync, configured ?? (store.get('sevenZipPath') as string | undefined))
  if (!path) return { path: null, exists: false, valid: false, version: null }
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (valid: boolean) => {
      if (settled) return
      settled = true
      resolve({ path, exists: true, valid, version: parse7zVersion(out) })
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(path, [], { windowsHide: true })
    } catch {
      resolve({ path, exists: true, valid: false, version: null })
      return
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* */
      }
      finish(looksLike7z(out))
    }, 4000)
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      finish(looksLike7z(out))
    })
  })
})

ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-user-data', () => app.getPath('userData'))
