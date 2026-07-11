import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, safeStorage } from 'electron'
import { join, resolve, dirname, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync, realpathSync } from 'fs'
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
import { initCatalogEngine } from './catalog/engine'
import { initInstallEngine } from './install/engine'
import { initDeployEngine } from './deploy/engine'
import { recoverOnStartup } from './delta/journal'
import { parseNxmUrl, findNxmUrl, createNxmDownload, validateNxmLink, type NxmLink } from './nexus/nxm'
import { NxmConsentStore } from './nexus/nxmConsent'
import { scanVortexMods, buildCatalog, defaultVortexModsRoot, type VortexScan } from './vortex/scan'
import { detectSteamEnv } from './steam/detect'
import { runPreflight, executeLaunch, buildLaunchEnv } from './launch/preflight'
import { runCompatReport } from './launch/compat'
import { getLoadOrder, saveLoadOrder } from './pluginManager'
import type { LoadOrderEntry } from '../src/types'
import { ensureSteamReady, liveSteamProbe, startSteam } from './steam/steamControl'
import { resolveBootstrapper } from './launch/bootstrapper'
import { runActiveLaunch, type ActiveLaunchDeps } from './launch/activeLaunch'
import { checkForLauncherUpdate } from './launch/launcherUpdate'
import {
  readSmartStartup,
  writeSmartStartup,
  recordLaunch,
  type KeyValueStore,
  type SmartStartupConfig,
} from './util/launcherConfig'
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
import { sanitizePathSegment } from './util/paths'
import {
  revealDirForKind,
  validateOpenPath,
  resolveReadDir,
  type RevealRoots,
  type RevealProbe,
} from './util/openTargets'
import { resolveActiveProfileId } from './util/activeProfile'
import { detectPandora, pandoraRoots, realFsProbe } from './tools/pandora'
import { autoDetectPaths, type DetectedPaths } from './tools/autoDetect'
import { launchGame, createDesktopShortcut, resolveLauncherIcon } from './launcher/launcherService'
import { streamToFile } from './install/downloadStream'
import { resolveDownloadLink } from './nexus/downloadLink'
import { axiosGet, axiosJson } from './http/axiosAdapters'
import { extractArchive } from './install/extract'
import { bundled7zaPath, resolveRar7z } from './install/sevenZip'
import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { logger } from './logger'

// Trust-anchor hardening (fixes the NODE_ENV-spoof vector). The pinned Ed25519 pubkey override
// and the anti-rollback floor relax themselves outside production (dev/test/ci) via NODE_ENV. In
// a PACKAGED build that env var must NEVER weaken the trust anchor — a local attacker launching
// with NODE_ENV=development would otherwise enable NOLVUS_MANIFEST_PUBKEY (forge any manifest) and
// zero the floor (downgrade). app.isPackaged reflects a real packaged binary and is not settable
// by an env var, so force production semantics whenever packaged, before any verify path runs.
try {
  if (app.isPackaged && process.env.NODE_ENV !== 'production') process.env.NODE_ENV = 'production'
} catch {
  /* app may be unavailable in a non-Electron context */
}

// Dev is signalled either by NODE_ENV or, when launched by vite-plugin-electron,
// by the injected VITE_DEV_SERVER_URL — the live renderer dev server to load.
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const isDev = process.env.NODE_ENV === 'development' || !!devServerUrl
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

// Fail-fast DB accessors. Every handler/service reaches the database through these:
// if a query is attempted before initDatabase() has run (or after a corrupt-DB abort
// left db=null), we throw a CLEAR, descriptive error instead of an opaque
// "Cannot read properties of null" — no undefined behaviour in the app lifecycle.
function getRawDb(): Database.Database {
  if (!db) throw new Error('DB non inizializzato: operazione richiesta prima del boot del database (o dopo un abort per DB corrotto)')
  return db
}
/** Same guarantee, exposed as the engine-agnostic SqliteDb surface used by the subsystems. */
function requireDb(): SqliteDb {
  return getRawDb() as unknown as SqliteDb
}

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
function initDatabase(): boolean {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'skyrim-manager.db')
  db = new Database(dbPath)

  // Durability/integrity/concurrency pragmas BEFORE any write (A3/A4).
  applyPragmas(db as unknown as SqliteDb)

  // Detect a corrupt database up front (C2) and FAIL CLOSED: writing CREATE/seed/
  // migrations against a corrupt file only compounds the damage and yields a
  // confusing later crash. Stop before any write, tell the user, and point at the
  // pre-delta VACUUM INTO recovery snapshot (see docs/DELTA-UPDATES-v2).
  if (!integrityCheck(db as unknown as SqliteDb)) {
    logger.error('db', 'integrity_check FALLITO — avvio interrotto prima di ogni scrittura')
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
    dialog.showErrorBox(
      'Database corrotto',
      'Il database del mod manager risulta corrotto (integrity_check fallito).\n\n' +
        "Per proteggere i dati l'avvio è stato interrotto PRIMA di qualsiasi scrittura.\n\n" +
        "Ripristina l'ultimo snapshot di backup (VACUUM INTO, vedi docs/DELTA-UPDATES-v2) " +
        'oppure rimuovi/sposta il file per ricrearne uno vuoto:\n' +
        dbPath,
    )
    app.quit()
    return false
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
  return true
}

// ─── Security hardening ─────────────────────────────────────────────────────
function applySecurityPolicies() {
  // Content-Security-Policy: in dev we must allow Vite's inline/eval HMR + ws;
  // in production we lock down to self. Connections to the Nexus API are allowed.
  // object-src/base-uri/form-action/frame-ancestors are locked down in BOTH modes:
  // there is no plugin content, no <base> rewriting, no form posts, and the app must
  // never be embeddable — these close injection vectors CSP omits by default.
  const lockdown =
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; "
  const csp = isDev
    ? lockdown +
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173 ws://localhost:5173; " +
      "img-src 'self' data: https:; connect-src 'self' http://localhost:5173 ws://localhost:5173 https://api.nexusmods.com https://www.nexusmods.com https://raw.githubusercontent.com"
    : lockdown +
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
      "font-src 'self' data:; connect-src 'self' https://api.nexusmods.com https://www.nexusmods.com https://raw.githubusercontent.com"

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })

  // The renderer needs NO powerful web permissions (camera, mic, geolocation,
  // notifications, USB…). Deny every request and check fail-closed, so even a
  // compromised renderer can't prompt for or silently gain them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

// Fantasy/Dragon launcher icon, resolved for both packaged (extraResources under
// process.resourcesPath) and unpacked/dev (__dirname-relative) layouts. Falls back
// to the legacy placeholder .ico so the window/shortcut always has SOME icon.
function resolveAppIcon(): string | null {
  return resolveLauncherIcon([
    join(process.resourcesPath || '', 'assets', 'dragon_launcher.ico'),
    join(__dirname, '../assets/dragon_launcher.ico'),
    join(process.resourcesPath || '', 'icons', 'icon.ico'),
    join(__dirname, '../resources/icons/icon.ico'),
  ])
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
      // The preload uses only contextBridge + ipcRenderer (both sandbox-safe), so we
      // run the renderer in the OS sandbox: a renderer compromise no longer has direct
      // Node/OS reach, only the vetted IPC surface. Belt-and-suspenders with contextIsolation.
      sandbox: true,
    },
    icon: resolveAppIcon() ?? join(__dirname, '../resources/icons/icon.ico'),
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Never let the renderer navigate away from the app, and route any window.open
  // / target=_blank to the OS browser instead of spawning an in-app BrowserWindow.
  // Only real web URLs (http/https) may be handed to the OS browser — a loose
  // startsWith('http') also matched schemes like "httpx:"/"http-evil:"; the strict
  // regex refuses anything that isn't genuinely http(s).
  const isWebUrl = (u: string) => /^https?:\/\//i.test(u)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  const devUrl = devServerUrl ?? (isDev ? 'http://localhost:5173' : null)
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = devUrl ? new URL(devUrl).origin : 'file://'
    if (!url.startsWith(allowed)) {
      e.preventDefault()
      if (isWebUrl(url)) shell.openExternal(url)
    }
  })

  if (devUrl) {
    mainWindow.loadURL(devUrl)
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

// nxm:// dispatch — CONSENT-GATED. The nxm:// handler is reachable by ANY web page, so a
// link must NEVER auto-download: otherwise an attacker page forces the victim's launcher to
// download AND auto-install (extract+deploy) an attacker-chosen file — a drive-by that can
// stage a malicious native SKSE plugin (DLL) which the game then loads. Instead every link is
// parsed, validated (game whitelist + expiry), and held as a PENDING CONSENT request; it only
// becomes a real download when the user approves it via the nxm:approve IPC. URLs arriving
// before the DB/queue exist (cold start) are buffered and flushed after init.
const pendingNxm: string[] = []
const nxmConsent = new NxmConsentStore({ genToken: () => randomUUID(), cap: 20 })

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
  const valid = validateNxmLink(link, { now: Date.now() })
  if (!valid.ok) {
    logger.warn('nxm', `URL nxm rifiutato (${valid.reason}): mod ${link.modId} file ${link.fileId}`)
    return
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const added = nxmConsent.add(link, Date.now())
  if (!added.ok) {
    logger.warn('nxm', `richiesta nxm scartata (${added.reason})`)
    return
  }
  // Signal the renderer to (re)load the pending list and show the consent modal. The event
  // carries no data — nxm:list-pending is the single source of truth (and never leaks the key).
  mainWindow?.webContents.send('nxm:confirm-request')
  void enrichNxmRequest(added.token, link)
}

/** Best-effort mod-name lookup so the consent prompt is readable. Silent on failure/no key. */
async function enrichNxmRequest(token: string, link: NxmLink) {
  const key = readSecret('nexusApiKey')
  if (!key) return
  try {
    const res = await axios.get(
      `https://api.nexusmods.com/v1/games/${link.game}/mods/${link.modId}.json`,
      { headers: { apikey: key, 'User-Agent': 'SkyrimAEModManager/1.0' }, timeout: 8000 },
    )
    const name = (res.data as { name?: unknown })?.name
    if (typeof name === 'string' && name) {
      nxmConsent.patch(token, { name })
      mainWindow?.webContents.send('nxm:confirm-request')
    }
  } catch {
    /* best-effort: the prompt falls back to the mod/file ids */
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
  // Fail closed on a corrupt DB: initDatabase has already shown the error and quit.
  if (!initDatabase()) return
  // Crash recovery (A5): reset any update left mid-flight to a re-runnable state.
  // Never advances installed_snapshot — only the gated finalize can do that.
  const rec = recoverOnStartup(requireDb())
  if (rec.resetRows || rec.resetDownloads) {
    logger.info(
      'delta',
      `recovery avvio: ${rec.resetRows} righe changeset, ${rec.resetDownloads} download ripristinati`,
    )
  }
  // Nexus credential preflight: log-only warning if no key; features degrade cleanly.
  nexusKeyPreflight()
  createWindow()
  // Single mods-folder resolver, shared by the installer engine and its deps.
  const modsRoot = () => (store.get('modsPath') as string) || join(app.getPath('userData'), 'mods')
  // Install engine: builds the InstallerService and sweeps any .staging dirs left
  // orphaned by a crash mid-install in a previous session (alongside the delta
  // recovery above).
  const installer = initInstallEngine({
    db: requireDb(),
    modsRoot,
    sevenZipPath: () => store.get('sevenZipPath') as string | undefined,
    log: (level, msg) => (level === 'warn' ? logger.warn('install', msg) : logger.info('install', msg)),
  })
  // Init subsystems. The install pipeline is wired into the download manager so
  // a completed download automatically extracts and deploys into the mods folder.
  const installManager = initInstallManager(getRawDb(), () => mainWindow, installer, {
    onComplete: (id) => onDeltaDownloadComplete(requireDb(), id),
    onError: (id, err) => onDeltaDownloadFailed(requireDb(), id, err),
  })
  downloadQueue = initDownloadManager(getRawDb(), () => mainWindow, {
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
  initBackupManager(getRawDb())
  initWabbajack(getRawDb())
  // Delta/incremental-update engine (signed-manifest ingest, diff, gated apply).
  initDeltaEngine(requireDb(), { enqueueDownload: (id) => downloadQueue?.enqueue(id) })
  // Reference mod catalog engine (signed catalog fetch + verify + atomic replace).
  initCatalogEngine(requireDb())
  // StockGame source/target resolvers — used both by the deploy engine's Creation
  // Club source and by the stockgame:* handlers below. Plain store reads, so there is
  // no init-order dependency and they can live here, ahead of their first use.
  const resolveGameSource = (): string | null =>
    (store.get('stockGameSource') as string | undefined) || detectSteamEnv().skyrim.path
  const resolveStockTarget = (): string =>
    (store.get('stockGamePath') as string | undefined) || defaultStockGameDir(app.getPath('userData'))

  // Deploy/virtualization engine: links the enabled mods of a profile into its
  // instance Data folder (hardlinks + junctions). The instance root lives on the
  // SAME volume as modsRoot (default under userData) so hardlinks are valid.
  initDeployEngine({
    db: requireDb(),
    resolveInstanceDataDir: (profileId) => {
      const prof = getRawDb().prepare('SELECT name FROM profiles WHERE id=?').get(profileId) as
        | { name: string }
        | undefined
      if (!prof) return null
      const instanceRoot =
        (store.get('instancePath') as string | undefined) || join(app.getPath('userData'), 'instances')
      const safe = sanitizePathSegment(prof.name, 'profile')
      return join(instanceRoot, safe, 'Data')
    },
    // Creation Club "System DLC" source: the isolated StockGame's Data folder.
    resolveStockGameDataDir: () => join(resolveStockTarget(), 'Data'),
    log: (level, msg) => (level === 'warn' ? logger.warn('deploy', msg) : logger.info('deploy', msg)),
  })

  // Steam detection + launch pre-flight (companion mode: read-only, gated launch).
  ipcMain.handle('steam:detect', () => detectSteamEnv())
  ipcMain.handle('launch:preflight', () => runPreflight(getRawDb(), store))
  ipcMain.handle('launch:run', () => executeLaunch(getRawDb(), store))

  // ── Modded game launcher (Nolvus/MO2-style) ──────────────────────────────────
  // Resolves the SAME target executeLaunch would run (MO2 if configured and valid,
  // else skse64_loader.exe next to the detected/configured game install) — the
  // renderer never supplies a path, it only asks to play or to pin a shortcut to
  // whatever is currently configured. Mirrors buildLaunchEnv's launchTarget logic
  // in electron/launch/preflight.ts (kept local here to avoid touching that
  // tested, gated preflight path for an unrelated feature).
  function resolveGameLaunchTarget(): { exe: string; cwd: string } | null {
    const mo2Path = store.get('mo2Path') as string | undefined
    if (mo2Path && existsSync(mo2Path) && /modorganizer\.exe$/i.test(mo2Path)) {
      return { exe: mo2Path, cwd: dirname(mo2Path) }
    }
    const gamePath = detectSteamEnv().skyrim.path ?? (store.get('gamePath') as string | undefined) ?? null
    if (gamePath) return { exe: join(gamePath, 'skse64_loader.exe'), cwd: gamePath }
    return null
  }

  // Fantasy/Dragon icon, resolved for packaged + dev layouts (see resolveAppIcon).
  const launcherIconPath = () => resolveAppIcon()

  // Bootstrap context = the swappable launch layer's inputs. Sourced from the same
  // detection buildLaunchEnv uses, so playGame and the active pipeline resolve the
  // identical target through electron/launch/bootstrapper.ts (MO2 → SKSE → DragonLoader).
  const bootstrapContext = () => ({
    gamePath: detectSteamEnv().skyrim.path ?? (store.get('gamePath') as string | undefined) ?? null,
    mo2Path: (store.get('mo2Path') as string | undefined) ?? null,
  })

  // Fire a resolved bootstrap target: detached exe (SKSE/MO2) or a Steam protocol
  // (DragonLoader → steam://run). No-throw; always resolves to a Result.
  async function fireBootstrap(): Promise<{ success: boolean; pid?: number; error?: string; via?: string }> {
    const target = resolveBootstrapper(bootstrapContext())
    if (!target) {
      return { success: false, error: 'Nessun metodo di avvio disponibile: configura MO2 o installa SKSE64' }
    }
    if (target.mode === 'protocol' && target.uri) {
      try {
        await shell.openExternal(target.uri)
        logger.info('launcher', `gioco avviato via ${target.bootstrapperName}: ${target.uri}`)
        return { success: true, via: target.bootstrapperId }
      } catch (e) {
        const error = (e as Error).message
        logger.warn('launcher', `avvio via ${target.bootstrapperName} fallito: ${error}`)
        return { success: false, error, via: target.bootstrapperId }
      }
    }
    const res = launchGame({ exePath: target.exe!, cwd: target.cwd!, args: target.args ?? [] })
    if (res.success) logger.info('launcher', `gioco avviato via ${target.bootstrapperName}: ${target.exe} (pid ${res.pid})`)
    else logger.warn('launcher', `avvio via ${target.bootstrapperName} fallito: ${res.error}`)
    return { ...res, via: target.bootstrapperId }
  }

  // Play: resolve + fire the bootstrapper directly (no gate). The gated, staged,
  // Steam-aware path is launch:active-run below; this is the quick "just play".
  ipcMain.handle('launcher:playGame', () => fireBootstrap())

  // ── One-Click Play: full ACTIVE launch pipeline ──────────────────────────────
  // Streams per-stage progress to the invoking renderer over 'launch:progress' and
  // returns the terminal ActiveLaunchResult. This is the launcher's primary entry:
  //   update → config → deps → install → STEAM(start+wait+login) → modded env →
  //   plugins → profile → integrity → BOOTSTRAP → game. Stops on the first critical
  //   failure with an actionable message; Steam is auto-started and never bypassed.
  ipcMain.handle('launch:active-run', async (e) => {
    const kvStore = store as unknown as KeyValueStore
    const deps: ActiveLaunchDeps = {
      buildEnv: () => buildLaunchEnv(getRawDb(), store),
      ensureSteam: (env) =>
        ensureSteamReady(
          {
            probe: liveSteamProbe,
            start: () =>
              env.steam.path ? startSteam(env.steam.path) : { started: false, error: 'Steam non installato' },
          },
          { timeoutMs: 90000, intervalMs: 2000, requireLogin: true },
        ),
      checkUpdate: () => checkForLauncherUpdate(),
      // Resolve from the env already built for this run (avoids a second Steam probe).
      resolveTarget: (env) =>
        resolveBootstrapper({
          gamePath: env.skyrim.path ?? (store.get('gamePath') as string | undefined) ?? null,
          mo2Path: env.mo2.path,
        }),
      launchExe: (t) => launchGame({ exePath: t.exe, cwd: t.cwd, args: t.args }),
      launchProtocol: async (uri) => {
        try {
          await shell.openExternal(uri)
          return { success: true }
        } catch (err) {
          return { success: false, error: (err as Error).message }
        }
      },
      onProgress: (ev) => {
        try {
          e.sender.send('launch:progress', ev)
        } catch {
          /* renderer gone mid-launch — the detached game keeps running */
        }
      },
      recordSuccess: (target) => {
        try {
          const profileId = resolveActiveProfileId(getRawDb(), store)
          recordLaunch(kvStore, { bootstrapperId: target.bootstrapperId, profileId }, new Date().toISOString())
        } catch (err) {
          logger.warn('launcher', `smart-startup non registrato: ${(err as Error).message}`)
        }
      },
    }
    const res = await runActiveLaunch(deps)
    logger.info(
      'launch',
      `pipeline attiva: launched=${res.launched} bootstrapper=${res.bootstrapperId ?? '-'} blocking=${res.blockingStage ?? '-'}`,
    )
    return res
  })

  // Launcher self-update check (best-effort; no-op without a packaged build + feed).
  ipcMain.handle('launcher:checkUpdate', () => checkForLauncherUpdate())

  // Smart-startup config (One-Click memory): get + patch.
  ipcMain.handle('launcher:smartConfig', () => readSmartStartup(store as unknown as KeyValueStore))
  ipcMain.handle('launcher:smartConfig:set', (_e, patch: Partial<SmartStartupConfig> | undefined) =>
    writeSmartStartup(store as unknown as KeyValueStore, patch ?? {}),
  )

  // Create a desktop .lnk pointing at the same resolved GAME target, so the user can
  // start the modded game without opening the mod manager at all (legacy convenience;
  // the installer already pins the launcher itself to the desktop).
  ipcMain.handle('launcher:createShortcut', () => {
    const target = resolveGameLaunchTarget()
    if (!target) {
      return { success: false, error: 'Nessun eseguibile risolvibile: configura MO2 o il percorso del gioco' }
    }
    const res = createDesktopShortcut({
      targetExePath: target.exe,
      shortcutName: 'Skyrim AE Mod Manager',
      workingDir: target.cwd,
      iconPath: launcherIconPath(),
      desktopDir: app.getPath('desktop'),
    })
    if (res.success) logger.info('launcher', `collegamento desktop creato: ${res.shortcutPath}`)
    else logger.warn('launcher', `creazione collegamento fallita: ${res.error}`)
    return res
  })

  // Pin the LAUNCHER itself (this app) to the desktop with the dragon icon — the
  // "unico punto di accesso". The NSIS installer does this on install; this handler
  // is for unpacked/portable runs, and to re-create a deleted shortcut on demand.
  ipcMain.handle('launcher:createAppShortcut', () => {
    const res = createDesktopShortcut({
      targetExePath: process.execPath,
      shortcutName: 'Skyrim AE Fantasy Launcher',
      workingDir: dirname(process.execPath),
      iconPath: launcherIconPath(),
      desktopDir: app.getPath('desktop'),
    })
    if (res.success) logger.info('launcher', `collegamento launcher creato: ${res.shortcutPath}`)
    else logger.warn('launcher', `creazione collegamento launcher fallita: ${res.error}`)
    return res
  })

  // Compatibility report (runtime/SKSE version + active-profile plugins.txt).
  ipcMain.handle('compat:analyze', () => runCompatReport(getRawDb(), store))

  // Load order (v1.1.0 "Conflict & Load Order"): the effective plugin order Skyrim
  // reads. Data source = the isolated StockGame Data (where mods are hardlinked) if
  // it exists, else the vanilla game Data; order source = the game's real plugins.txt
  // in %LOCALAPPDATA%.
  const resolveLoadOrderDataDir = (): string => {
    const stockData = join(resolveStockTarget(), 'Data')
    const gamePath = detectSteamEnv().skyrim.path ?? (store.get('gamePath') as string | undefined) ?? null
    return existsSync(stockData) ? stockData : gamePath ? join(gamePath, 'Data') : ''
  }
  const resolvePluginsTxtPath = (): string => {
    const localAppData = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
    return join(localAppData, 'Skyrim Special Edition', 'plugins.txt')
  }

  ipcMain.handle('plugin:get-order', () =>
    getLoadOrder({ dataDir: resolveLoadOrderDataDir(), pluginsTxtPath: resolvePluginsTxtPath() }),
  )

  // Write the load order back to the real plugins.txt (Milestone 2). Backs up the
  // current file to plugins.txt.bak, writes atomically, and never throws — returns
  // a { success, error?, backupPath, written } Result to the renderer.
  ipcMain.handle('plugin:save-order', (_e, entries: LoadOrderEntry[]) => {
    const res = saveLoadOrder(entries, resolvePluginsTxtPath())
    if (res.success) logger.info('plugin', `plugins.txt salvato (${res.written} righe, backup: ${res.backupPath ?? 'nessuno'})`)
    else logger.warn('plugin', `salvataggio plugins.txt fallito: ${res.error}`)
    return res
  })

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
  // (resolveGameSource / resolveStockTarget are declared above, next to the deploy engine.)
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
  const md5File = (path: string): Promise<string> =>
    new Promise((res, rej) => {
      const h = createHash('md5')
      createReadStream(path)
        .on('data', (d) => h.update(d as Buffer))
        .on('end', () => res(h.digest('hex')))
        .on('error', rej)
    })
  // Recursively sum file sizes under `p` (0 if missing/empty). Used by the resume
  // check to distinguish a finished extraction from an empty/corrupt partial dir.
  const dirBytesSync = (p: string): number => {
    let total = 0
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const e of entries) {
      const abs = join(p, e.name)
      try {
        if (e.isDirectory()) total += dirBytesSync(abs)
        else if (e.isFile()) total += statSync(abs).size
      } catch {
        /* skip unreadable entry */
      }
    }
    return total
  }
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
    // Real bytes under an extracted mod dir (statSync-summed) — resume uses this to tell
    // a completed mod from an empty/corrupt partial and re-extract the latter.
    dirBytes: (p) => dirBytesSync(p),
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
      {
        mods,
        stockGameDir: stockDir,
        downloadsDir: join(app.getPath('userData'), 'downloads'),
        ...syncFactors(),
      },
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

/** True when the Nexus provider is enabled (in-app toggle or NEXUS_ENABLED env). */
function nexusEnabled(): boolean {
  return process.env.NEXUS_ENABLED === 'true' || store.get('nexusEnabled') === true
}

/**
 * Boot preflight for the Nexus credential. NEVER throws — it only logs the state so a
 * headless / first run makes a missing key obvious. The existing gates (sync:start,
 * nxm dispatch, the deferred mock provider) already keep Nexus features cleanly
 * DISABLED until a key is configured, so this is graceful degradation, not a hard stop.
 * The key lives ONLY in the encrypted app_secrets store — never on disk in clear text,
 * and never in .env for the app (that env var is a convenience for the dev scripts).
 */
function nexusKeyPreflight(): void {
  const hasKey = !!(readSecret('nexusApiKey') || '').trim()
  if (hasKey) {
    logger.info(
      'nexus',
      `API key presente (provider ${nexusEnabled() ? 'attivo' : 'in attesa: abilita Nexus in Impostazioni'})`,
    )
    return
  }
  const envKeyOnly = !!(process.env.NEXUS_API_KEY || '').trim()
  logger.warn(
    'nexus',
    envKeyOnly
      ? "Nessuna API key Nexus nel secret store cifrato (NEXUS_API_KEY è nell'ambiente ma serve solo agli script). Configura la chiave in Impostazioni per abilitare download/aggiornamenti in-app."
      : 'Nessuna API key Nexus configurata: funzionalità Nexus (download, aggiornamenti, risoluzione file) DISABILITATE (degradazione controllata). Impostala in Impostazioni o esporta NEXUS_API_KEY.',
  )
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
  // electron-store uses dot-prop: a dotted/crafted key ("a.b", "__proto__.x") would
  // reach a NESTED path or a dangerous property. Every real setting is a flat
  // identifier, so reject anything else up front (config-clobber / pollution guard).
  if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
    logger.warn('security', `settings:set rifiutato (chiave non valida): ${String(key).slice(0, 80)}`)
    return
  }
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
  return getRawDb().prepare('SELECT * FROM profiles ORDER BY created_at ASC').all()
})

ipcMain.handle('profiles:create', (_e, data: { name: string; description?: string }) => {
  const result = getRawDb()
    .prepare('INSERT INTO profiles (name, description) VALUES (?, ?)')
    .run(data.name, data.description ?? '')
  return getRawDb().prepare('SELECT * FROM profiles WHERE id = ?').get(result.lastInsertRowid)
})

ipcMain.handle('profiles:update', (_e, id: number, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, PROFILE_COLUMNS)
  if (Object.keys(data).length === 0) return getRawDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id)
  const fields = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ')
  getRawDb()
    .prepare(`UPDATE profiles SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(data), id)
  return getRawDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id)
})

ipcMain.handle('profiles:delete', (_e, id: number) => {
  // FK-safe order (foreign_keys=ON): remove children without ON DELETE CASCADE
  // first (downloads → mods), then the profile (installed_snapshot / delta_changeset
  // cascade automatically).
  const tx = getRawDb().transaction((profileId: number) => {
    getRawDb().prepare('DELETE FROM downloads WHERE profile_id = ?').run(profileId)
    getRawDb().prepare('DELETE FROM mods WHERE profile_id = ?').run(profileId)
    getRawDb().prepare('DELETE FROM profiles WHERE id = ?').run(profileId)
  })
  tx(id)
})

// ─── Mods IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('mods:list', (_e, profileId: number) => {
  return getRawDb()
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
  const result = getRawDb()
    .prepare(`INSERT INTO mods (${cols}) VALUES (${placeholders})`)
    .run(...Object.values(data))
  return getRawDb().prepare('SELECT * FROM mods WHERE id = ?').get(result.lastInsertRowid)
})

// Bulk insert in UNA transazione: l'import di un modlist.txt da migliaia di righe
// non paga più un round-trip IPC + una transazione implicita per riga.
ipcMain.handle('mods:add-many', (_e, rawRows: Record<string, unknown>[]) => {
  const rows = rawRows.map((r) => pickColumns(r, MOD_COLUMNS)).filter((r) => r.name)
  if (!rows.length) return { inserted: 0 }
  const tx = getRawDb().transaction((items: Record<string, unknown>[]) => {
    for (const data of items) {
      const cols = Object.keys(data).join(', ')
      const placeholders = Object.keys(data)
        .map(() => '?')
        .join(', ')
      getRawDb().prepare(`INSERT INTO mods (${cols}) VALUES (${placeholders})`).run(...Object.values(data))
    }
  })
  tx(rows)
  return { inserted: rows.length }
})

ipcMain.handle('mods:update', (_e, id: number, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, MOD_COLUMNS)
  if (Object.keys(data).length === 0) return getRawDb().prepare('SELECT * FROM mods WHERE id = ?').get(id)
  const fields = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ')
  getRawDb()
    .prepare(`UPDATE mods SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(data), id)
  return getRawDb().prepare('SELECT * FROM mods WHERE id = ?').get(id)
})

ipcMain.handle('mods:delete', (_e, id: number) => {
  // FK-safe: downloads reference mods(id) without cascade — remove them first.
  const tx = getRawDb().transaction((modId: number) => {
    getRawDb().prepare('DELETE FROM downloads WHERE mod_id = ?').run(modId)
    getRawDb().prepare('DELETE FROM mods WHERE id = ?').run(modId)
  })
  tx(id)
})

ipcMain.handle('mods:reorder', (_e, profileId: number, orderedIds: number[]) => {
  const update = getRawDb().prepare('UPDATE mods SET priority = ? WHERE id = ? AND profile_id = ?')
  const transaction = getRawDb().transaction((ids: number[]) => {
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
  return getRawDb().prepare(query).all(...params)
})

ipcMain.handle('catalog:seed', (_e, mods: unknown[]) => {
  const insert = getRawDb().prepare(`
    INSERT OR REPLACE INTO modlist_catalog
    (nexus_id, name, category, subcategory, priority_order, required, description, author, tags, size_mb, has_it_translation, notes, conflicts_with, requires)
    VALUES (@nexus_id, @name, @category, @subcategory, @priority_order, @required, @description, @author, @tags, @size_mb, @has_it_translation, @notes, @conflicts_with, @requires)
  `)
  const insertMany = getRawDb().transaction((rows: unknown[]) => {
    for (const row of rows) insert.run(row as Record<string, unknown>)
  })
  insertMany(mods)
  return { inserted: mods.length }
})

// ─── Downloads IPC ────────────────────────────────────────────────────────────
ipcMain.handle('downloads:list', (_e, profileId: number) => {
  // Explicit column list (NOT SELECT *): the nxm_key / nxm_expires non-premium download
  // token is a short-lived secret used only main-side and must never reach the renderer.
  return getRawDb()
    .prepare(
      `SELECT id, mod_id, profile_id, nexus_id, file_id, name, url, file_path,
              total_size, downloaded_size, status, error, created_at
       FROM downloads WHERE profile_id = ? ORDER BY created_at DESC`,
    )
    .all(profileId)
})

ipcMain.handle('downloads:add', (_e, raw: Record<string, unknown>) => {
  const data = pickColumns(raw, DOWNLOAD_COLUMNS)
  if (!data.name) throw new Error('downloads:add richiede almeno un campo "name"')
  const cols = Object.keys(data).join(', ')
  const placeholders = Object.keys(data)
    .map(() => '?')
    .join(', ')
  const result = getRawDb()
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
      getRawDb().prepare(`UPDATE downloads SET ${fields} WHERE id = ?`).run(status, ...Object.values(extra), id)
    } else {
      getRawDb().prepare('UPDATE downloads SET status = ? WHERE id = ?').run(status, id)
    }
  },
)

// ─── Nexus API IPC ────────────────────────────────────────────────────────────
// The API key is ALWAYS read from the main-side secret store: the renderer never
// holds the real key (it only sees SECRET_MASK), so a compromised renderer cannot
// exfiltrate it and the legacy `apiKey` parameter from old callers is ignored.
ipcMain.handle('nexus:get-mod', async (_e, nexusId: number) => {
  // nexusId is interpolated into the API URL and the request carries the API key, so
  // reject anything that isn't a positive integer (no path/query injection into the URL).
  if (!Number.isInteger(nexusId) || nexusId <= 0) return { success: false, error: 'nexusId non valido' }
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
    // NEVER return res.data raw: the Nexus validate endpoint echoes the submitted
    // API key back in res.data.key (plus the account email), so forwarding the raw
    // body would hand the plaintext secret to the renderer on every "Verifica" click
    // — defeating the whole main-side secret store. Whitelist non-secret display
    // fields only (same contract as the mock provider); drop key/email/user_id.
    const d = (res.data ?? {}) as Record<string, unknown>
    return {
      success: true,
      data: { name: d.name, is_premium: d.is_premium, is_supporter: d.is_supporter },
    }
  } catch {
    return { success: false }
  }
})

// ─── nxm:// consent-gate IPC ──────────────────────────────────────────────────
// The renderer lists pending consent requests and approves/rejects them by token.
// nxm:approve is the ONLY path that creates a download row + enqueues it; the renderer
// never sees the non-premium key (nxmConsent.list() strips it).
ipcMain.handle('nxm:list-pending', () => nxmConsent.list())
ipcMain.handle('nxm:approve', (_e, token: string) => {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'token non valido' }
  const req = nxmConsent.take(token)
  if (!req) return { ok: false, error: 'richiesta non trovata o già gestita' }
  // Re-validate at approval time: the user may have sat on the prompt past the link's expiry.
  const valid = validateNxmLink(req.link, { now: Date.now() })
  if (!valid.ok) {
    logger.warn('nxm', `approvazione rifiutata (${valid.reason}): mod ${req.link.modId}`)
    return { ok: false, error: valid.reason }
  }
  try {
    const profileId = resolveActiveProfileId(getRawDb(), store)
    const id = createNxmDownload(getRawDb() as unknown as SqliteDb, req.link, {
      profileId,
      name: req.name,
    })
    downloadQueue?.enqueue(id)
    logger.info(
      'nxm',
      `download APPROVATO dall'utente: mod ${req.link.modId} file ${req.link.fileId} (#${id}${req.link.key ? ', non-premium' : ''})`,
    )
    mainWindow?.webContents.send('nxm:queued', { id, modId: req.link.modId, fileId: req.link.fileId })
    return { ok: true, id }
  } catch (e) {
    logger.error('nxm', `accodamento nxm fallito: ${(e as Error).message}`)
    return { ok: false, error: (e as Error).message }
  }
})
ipcMain.handle('nxm:reject', (_e, token: string) => {
  const removed = typeof token === 'string' && nxmConsent.reject(token)
  if (removed) logger.info('nxm', "richiesta nxm rifiutata dall'utente")
  return { ok: !!removed }
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

// Intent-based directory listing (confines the old whole-disk read-dir oracle). The renderer
// names a whitelisted folder `kind` (never a path); an optional RELATIVE subpath may descend
// within that one root, with `..`/symlink escapes rejected by resolveReadDir (realpath +
// containment). Entry names/sizes only — the absolute path is not returned to the renderer.
// Async + one stat per entry via Dirent so a big directory never freezes the main process.
ipcMain.handle('fs:read-dir', async (_e, kind: string, subpath?: string) => {
  const decision = resolveReadDir(kind, revealRoots(), subpath, revealProbe)
  if (!decision.ok) {
    logger.warn('security', `fs:read-dir rifiutato (${decision.reason}): kind=${String(kind).slice(0, 40)}`)
    return { ok: false, error: decision.reason, entries: [] }
  }
  try {
    const entries = await readdir(decision.path, { withFileTypes: true })
    const out = await Promise.all(
      entries.map(async (d) => {
        const isDirectory = d.isDirectory()
        const size = isDirectory
          ? 0
          : await stat(join(decision.path, d.name))
              .then((s) => s.size)
              .catch(() => 0)
        return { name: d.name, isDirectory, size }
      }),
    )
    return { ok: true, entries: out }
  } catch (e) {
    return { ok: false, error: (e as Error).message, entries: [] }
  }
})

// Intent-based file opening. The renderer NEVER passes a path: it names a fixed folder
// `kind` or a numeric download id, and the main process resolves the concrete path from the
// settings store / DB. This replaces the old `fs:open-path(path)` handler, which handed any
// renderer-supplied path straight to shell.openPath — arbitrary local-file open, and RUN for
// an executable/UNC path (LFI → RCE via an XSS'd mod name/description/catalog value).
const APP_MANAGED_KINDS = new Set(['backups', 'downloads', 'logs', 'mods', 'stockGame', 'instances'])
function revealRoots(): RevealRoots {
  const ud = app.getPath('userData')
  const mo2 = store.get('mo2Path') as string | undefined
  return {
    backups: join(ud, 'backups'),
    downloads: join(ud, 'downloads'),
    logs: join(ud, 'logs'),
    mods: (store.get('modsPath') as string) || join(ud, 'mods'),
    stockGame: (store.get('stockGamePath') as string) || defaultStockGameDir(ud),
    instances: (store.get('instancePath') as string) || join(ud, 'instances'),
    game: (store.get('gamePath') as string) || null,
    mo2: mo2 ? dirname(mo2) : null,
  }
}
// realpathSync.native throws on a missing path; validateOpenPath only calls realpath after
// its own existsSync guard, so this adapter is safe.
const revealProbe: RevealProbe = { exists: existsSync, realpath: (p) => realpathSync.native(p) }

// Open one of a FIXED set of authorized folders in the OS file manager. `kind` is validated
// against the whitelist; opening a directory never executes anything.
ipcMain.handle('fs:reveal-folder', async (_e, kind: string) => {
  const dir = revealDirForKind(kind, revealRoots())
  if (!dir) {
    logger.warn('security', `fs:reveal-folder rifiutato (kind non valido/non configurato): ${String(kind).slice(0, 60)}`)
    return { success: false, error: 'Cartella non disponibile' }
  }
  // App-managed dirs may not exist yet on first use; create them. We never create the
  // externally-owned game/MO2 dirs — if missing, openPath simply reports it.
  if (APP_MANAGED_KINDS.has(kind)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* best-effort */
    }
  }
  // Harden the sink: the game/mo2 (and modsPath/stockGamePath/instancePath) kinds resolve to
  // store values a compromised renderer can set via settings:set. shell.openPath EXECUTES a
  // file target (e.g. an .exe) and mounts a UNC share, so require the resolved path to be a
  // real, EXISTING DIRECTORY and not a UNC path before opening it — a file/exe never reaches
  // the sink. realpath first so a junction pointing at a file is caught by isDirectory().
  if (/^\\\\/.test(dir) || /^\/\//.test(dir)) {
    logger.warn('security', `fs:reveal-folder rifiutato (percorso UNC): ${dir.slice(0, 120)}`)
    return { success: false, error: 'Cartella non disponibile' }
  }
  let realDir: string
  try {
    realDir = existsSync(dir) ? realpathSync.native(dir) : dir
    if (!statSync(realDir).isDirectory()) {
      logger.warn('security', `fs:reveal-folder rifiutato (non è una directory): ${dir.slice(0, 120)}`)
      return { success: false, error: 'Cartella non disponibile' }
    }
  } catch {
    return { success: false, error: 'Cartella non disponibile' }
  }
  const err = await shell.openPath(realDir) // '' on success, an error string otherwise
  if (err) {
    logger.warn('fs', `fs:reveal-folder: apertura fallita (${kind}): ${err}`)
    return { success: false, error: err }
  }
  return { success: true }
})

// Reveal a COMPLETED download in the file manager (showItemInFolder — never opens/executes
// the file). The renderer passes only the numeric id; the path is looked up in the DB and must
// resolve inside an authorized root and not be an executable.
ipcMain.handle('fs:open-download', (_e, downloadId: number) => {
  if (!Number.isInteger(downloadId) || downloadId <= 0) return { success: false, error: 'id non valido' }
  const row = getRawDb().prepare('SELECT file_path FROM downloads WHERE id=?').get(downloadId) as
    | { file_path: string | null }
    | undefined
  if (!row?.file_path) return { success: false, error: 'File non disponibile' }
  const decision = validateOpenPath(row.file_path, revealRoots(), revealProbe)
  if (!decision.ok) {
    logger.warn('security', `fs:open-download rifiutato (${decision.reason}): ${row.file_path.slice(0, 120)}`)
    return { success: false, error: 'Percorso non autorizzato' }
  }
  shell.showItemInFolder(decision.path) // reveal in Explorer; does not launch the file
  return { success: true }
})

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
// Per-tool expected executable basename. Even though tool paths are set through the
// trusted pickFile dialog, we RE-VALIDATE the basename here at the spawn sink: a
// tampered/mis-set store value (or a future settings bug) then cannot turn a
// "launch tool" action into launching an arbitrary binary. This is the concrete
// enforcement of the "renderer picks WHICH tool, never WHAT exe" invariant.
const TOOL_BINARIES: Record<string, RegExp> = {
  mo2Path: /^modorganizer\.exe$/i,
  lootPath: /^loot(\.exe)?$/i,
  sseeditPath: /^(sseedit|sseedit64|xedit|xedit64)\.exe$/i,
  dyndolodPath: /^dyndolod(x?64)?\.exe$/i,
  pandoraPath: /^pandora.*\.exe$/i,
}
const toolPath = (key: string): string | null => {
  const p = store.get(key)
  if (typeof p !== 'string' || !p || !existsSync(p)) return null
  const expected = TOOL_BINARIES[key]
  if (expected && !expected.test(basename(p))) {
    logger.warn('security', `tool ${key} ignorato: basename inatteso "${basename(p)}"`)
    return null
  }
  return p
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
  // Identity gate BEFORE spawn: only a genuine 7-Zip binary basename may be launched.
  // The banner/looksLike7z check runs only AFTER the child starts, so without this a
  // renderer-supplied `configured` path would already have executed an arbitrary exe.
  if (!/^(7z|7za|7zg|7zr)\.exe$/i.test(basename(path))) {
    logger.warn('security', `tools:validate-7z: basename non-7-Zip rifiutato "${basename(path)}"`)
    return { path, exists: true, valid: false, version: null }
  }
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
