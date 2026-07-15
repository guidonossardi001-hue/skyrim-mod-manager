import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, safeStorage, Menu } from 'electron'
import { join, resolve, dirname, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync, realpathSync, cpSync, openSync, readSync, closeSync } from 'fs'
import { readdir, lstat } from 'fs/promises'
import { spawn } from 'child_process'
import Store from 'electron-store'
import Database from 'better-sqlite3'
import axios from 'axios'
import { initDownloadManager } from './downloadManager'
import { initInstallManager } from './installManager'
import { initBackupManager } from './backupManager'
import { initWabbajack } from './wabbajack'
import { applyPragmas, checkpointOnQuit, integrityCheck, type SqliteDb } from './db/sqlite'
import { runMigrations } from './db/migrations'
import { setSecret, getSecret, hasSecret, type SecretCrypto } from './db/secrets'
import { initDeltaEngine, onDeltaDownloadComplete, onDeltaDownloadFailed } from './delta/engine'
import { initCatalogEngine, triggerBootCatalogUpdate } from './catalog/engine'
import { buildCatalogRowsFromBackup, removeVortexNameDuplicates } from './catalog/vortexImport'
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
import { initCrashEngine, armCrashWatch } from './launch/crashEngine'
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
  buildVariants,
  isTextureProfile,
  resolveMods,
  DEFAULT_TEXTURE_PROFILE,
  type TextureProfile,
} from './sync/textureProfile'
import { pairBackupTranslations, saveTranslations, resolveTranslation } from './sync/translationResolver'
import { scanPluginBudget, VANILLA_FULL_MASTERS } from './install/pluginBudget'
import {
  runMassSync,
  stockGameModsDir,
  modDestDir,
  type MassSyncDeps,
  type SyncMod,
  type SyncProgress,
} from './sync/massSync'
import { computeRequiredSpace, decideDiskGate } from './sync/diskGatekeeper'
import { computePrunePlan, isPruneError, type BackupCollectionsLike } from './catalog/collectionPrune'
import { registerInstalledMods, type InstalledCandidate } from './sync/registerInstalled'
import { validateDownloadSchema, validateCatalogLinks, summarizeInvalid } from './catalog/downloadSchema'
import { getFreeSpace } from './install/diskSpace'
import { sameVolume } from './install/stockGame'
import { sanitizePathSegment } from './util/paths'
import { validateSettingWrite } from './util/settingsGuard'
import {
  revealDirForKind,
  validateInsideRoot,
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
import {
  parseCollectionInput,
  fetchCollectionRevision,
  buildCatalogRowsFromCollection,
  type CollectionRevisionResult,
} from './nexus/collections'
import { axiosGet, axiosJson, axiosPostJson, axiosText } from './http/axiosAdapters'
import { initMasterlistEngine } from './plugins/masterlistEngine'
import { MASTERLIST_CACHE_FILE } from './plugins/masterlistCache'
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
      // Launcher senza campi di testo libero: lo spellchecker Chromium (dizionari +
      // servizio) è solo overhead di memoria/avvio.
      spellcheck: false,
    },
    icon: resolveAppIcon() ?? join(__dirname, '../resources/icons/icon.ico'),
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })
  // Fallback anti finestra-fantasma (electronjs.org/docs BrowserWindow, issue #13532):
  // se il renderer muore prima del primo paint, ready-to-show non scatta MAI e l'app
  // resterebbe un processo invisibile. Mostrare comunque dopo un tetto massimo.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }, 5000)
  // Una load fallita in produzione (asset mancante, profilo utente corrotto) senza
  // handler = finestra nera silenziosa: logghiamo la causa reale.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error('main', `did-fail-load ${code} ${desc} su ${url}`)
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
// Cold-start buffer cap: the nxmConsent store already caps at 20 AFTER the DB is ready, but URLs
// arriving BEFORE init sit here unbounded — a page firing a burst of nxm:// links at launch could
// flood memory. Cap it the same way; extra links are dropped with a warning (default-deny).
const PENDING_NXM_CAP = 20
const nxmConsent = new NxmConsentStore({ genToken: () => randomUUID(), cap: 20 })

function handleNxmUrl(raw: string) {
  if (!db || !downloadQueue) {
    if (pendingNxm.length >= PENDING_NXM_CAP) {
      logger.warn('nxm', `buffer nxm pre-init pieno (${PENDING_NXM_CAP}): link scartato`)
      return
    }
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

// Nessun menu nativo (UI frameless custom): evita la costruzione del menu di default a
// ogni avvio/finestra — checklist performance ufficiale Electron, punto 8. Solo in
// produzione: in dev il menu di default porta gli accelerator DevTools (Ctrl+Shift+I).
if (!isDev) Menu.setApplicationMenu(null)

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
  const installConcurrency = Math.max(1, Math.min(4, Number(store.get('installConcurrency')) || 3))
  const installManager = initInstallManager(
    getRawDb(),
    () => mainWindow,
    installer,
    {
      onComplete: (id) => onDeltaDownloadComplete(requireDb(), id),
      onError: (id, err) => onDeltaDownloadFailed(requireDb(), id, err),
    },
    installConcurrency,
  )
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
  // Boot auto-refresh: pull the signed 4000+ catalog in the background so the DB
  // is not stuck on the bundled seed. Fire-and-forget, never blocks boot — a
  // missing NOLVUS_MOD_CATALOG_URL or network failure is a logged no-op.
  triggerBootCatalogUpdate()
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
    // plugins.txt DI SISTEMA: %LOCALAPPDATA%/Skyrim Special Edition — è quello che il gioco legge
    // quando parte via SKSE diretto (senza MO2). Scritto solo se la cartella esiste già (gioco
    // installato/avviato almeno una volta): non creiamo alberi in LOCALAPPDATA al buio.
    resolveSystemPluginsDir: () => {
      const base = process.env.LOCALAPPDATA
      if (!base) return null
      const dir = join(base, 'Skyrim Special Edition')
      return existsSync(dir) ? dir : null
    },
    // Masterlist-lite LOOT-like (regole "after" soft): file opzionale in userData,
    // editabile dall'utente; assente → zero regole, nessun errore.
    resolveMasterlistPath: () => join(app.getPath('userData'), 'masterlist.json'),
    // Cache del masterlist LOOT reale (masterlist:refresh la scrive; qui la si legge soltanto).
    resolveLootMasterlistCachePath: () => join(app.getPath('userData'), MASTERLIST_CACHE_FILE),
    log: (level, msg) => (level === 'warn' ? logger.warn('deploy', msg) : logger.info('deploy', msg)),
  })

  // Masterlist LOOT reale: refresh ESPLICITO (mai automatico al boot) + status dalla cache locale.
  initMasterlistEngine({
    resolveCachePath: () => join(app.getPath('userData'), MASTERLIST_CACHE_FILE),
    http: axiosText,
    nowIso: () => new Date().toISOString(),
    log: (level, msg) => (level === 'warn' ? logger.warn('masterlist', msg) : logger.info('masterlist', msg)),
  })

  // Analizzatore crash log (Crash Logger SSE/AE/VR, Trainwreck): sola lettura, nessuna azione
  // sul gioco. Legge dalla cartella SKSE standard o da un file scelto manualmente.
  initCrashEngine()

  // Auto-analisi post-lancio: al primo crash-*.log NUOVO dopo un GIOCA riuscito, il main
  // analizza da solo e notifica il renderer (toast con modulo probabile colpevole).
  const armPostLaunchCrashWatch = () => {
    armCrashWatch({
      sinceMs: Date.now(),
      onFound: ({ file, report, analysis }) => {
        logger.warn(
          'crash',
          `crash rilevato dopo il lancio: ${file}${analysis.culprit ? ` — modulo probabile: ${analysis.culprit.module}` : ''}`,
        )
        try {
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('crash:detected', {
              file,
              exceptionType: report.exceptionType,
              culpritModule: analysis.culprit?.module ?? null,
              suggestions: analysis.suggestions,
            })
        } catch {
          /* finestra chiusa: resta il log */
        }
      },
    })
  }

  // Steam detection + launch pre-flight (companion mode: read-only, gated launch).
  ipcMain.handle('steam:detect', () => detectSteamEnv())
  ipcMain.handle('launch:preflight', () => runPreflight(getRawDb(), store))
  ipcMain.handle('launch:run', async () => {
    const r = await executeLaunch(getRawDb(), store)
    if (r.launched) armPostLaunchCrashWatch()
    return r
  })

  // ── Modded game launcher ─────────────────────────────────────────────────────
  // DIRETTIVA: avvio esclusivo via SKSE interno (skse64_loader.exe accanto al gioco).
  // MO2 non è mai un target di lancio — allineato al registry dei bootstrapper e a
  // buildLaunchEnv in electron/launch/preflight.ts.
  function resolveGameLaunchTarget(): { exe: string; cwd: string } | null {
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
      return { success: false, error: 'Nessun metodo di avvio disponibile: installa SKSE64 nella cartella del gioco' }
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
    if (res.success) {
      logger.info('launcher', `gioco avviato via ${target.bootstrapperName}: ${target.exe} (pid ${res.pid})`)
      armPostLaunchCrashWatch()
    } else logger.warn('launcher', `avvio via ${target.bootstrapperName} fallito: ${res.error}`)
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
        armPostLaunchCrashWatch()
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
    // Overlay (Phase B): extract the translation into a temp sibling atomically, then copy its
    // files OVER the base mod dir (overwrite matching, keep the rest), then drop the temp.
    extractOverlay: async (archive, destDir, onProgress, signal) => {
      const tmp = `${destDir}.trans.tmp`
      try {
        if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      // finally-cleanup: the tmp dir lives INSIDE StockGame/mods — leaked on a cpSync/extract
      // failure it would look like a mod dir to every scan (plugin budget, deploy). Phase B is
      // fail-soft, so without this the leak was PERMANENT (the mod never re-runs).
      try {
        const r = await extractArchive(archive, tmp, {
          bundled7zaPath: bundled7zaPath(),
          full7zPath: resolveRar7z(store.get('sevenZipPath') as string | undefined) ?? undefined,
          onProgress,
          signal,
        })
        cpSync(tmp, destDir, { recursive: true, force: true }) // overlay over the base
        return { method: r.method }
      } finally {
        try {
          rmSync(tmp, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    },
    exists: existsSync,
    writeFile: (p, data) => writeFileSync(p, data, 'utf8'),
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
  // The disk-gate factors are a SAFETY feature: clamp them to sane floors so a (possibly
  // renderer-written) setting can never weaken the gate below reality (e.g. overhead 0.01 would
  // certify a run that fills the disk). Range: overhead [1..5], cross-disk headroom [1..3].
  const clampFactor = (v: unknown, lo: number, hi: number): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : undefined
  }
  const syncFactors = () => ({
    extractionOverhead: clampFactor(store.get('extractionOverhead'), 1, 5),
    safetyFactor: clampFactor(store.get('diskSafetyFactor'), 1, 3),
  })
  // Global texture quality profile (2K/4K). Validated; unknown/unset → default 4K.
  const syncTextureProfile = (): TextureProfile => {
    const v = store.get('textureQualityProfile')
    return isTextureProfile(v) ? v : DEFAULT_TEXTURE_PROFILE
  }
  // ESL/254 budget scan over the installed StockGame/mods. Walks the tree for plugin files and
  // reads each one's 12-byte TES4 header (to detect an ESL-FLAGGED .esp/.esm, not just .esl ext).
  const readPluginHead = (p: string): Uint8Array | null => {
    let fd: number | null = null
    try {
      fd = openSync(p, 'r')
      const buf = Buffer.alloc(12)
      readSync(fd, buf, 0, 12, 0)
      return new Uint8Array(buf)
    } catch {
      return null
    } finally {
      // close in finally: a readSync throw must not leak the descriptor (locks the file on Windows)
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
      }
    }
  }
  const scanInstalledPluginBudget = (modsDir: string) => {
    const paths: string[] = []
    const walk = (dir: string) => {
      let entries: import('fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        // Skip in-flight/leaked temp dirs (`<mod>.tmp` from extractArchive, `<mod>.trans.tmp` from
        // the ITA overlay): they are not installed mods and would double-count plugins.
        if (e.isDirectory()) {
          if (!/\.tmp$/i.test(e.name)) walk(full)
        } else if (/\.(esp|esm|esl)$/i.test(e.name)) paths.push(full)
      }
    }
    walk(modsDir)
    // Reserve the 5 vanilla full masters: they occupy load-order slots the mods can't use.
    return scanPluginBudget(paths, readPluginHead, undefined, VANILLA_FULL_MASTERS)
  }
  // ── Sorgente sync: backup persistito → scan live, con sanificazione fail-safe ───────────────
  /** Primo backup collezioni parseabile tra i percorsi noti (settings → userData → cwd/data). */
  const readBackupRaw = (): { backup: BackupCollectionsLike & { deduped?: unknown[] }; path: string } | null => {
    const candidates = [
      store.get('collectionsBackupPath') as string | undefined,
      join(app.getPath('userData'), 'vortex-collections-backup.json'),
      join(process.cwd(), 'data', 'vortex-collections-backup.json'),
    ].filter(Boolean) as string[]
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue
        return { backup: JSON.parse(readFileSync(p, 'utf8')), path: p }
      } catch {
        /* try next */
      }
    }
    return null
  }

  /** Mappa il backup grezzo nella lista SyncMod (con ricostruzione varianti 2K/4K dalle raw). */
  const backupToSyncMods = (b: BackupCollectionsLike & { deduped?: unknown[] }): SyncMod[] => {
    const arr = (b.deduped ?? []) as Array<{
      modId: number
      fileId: number
      name: string
      md5?: string
      fileSize?: number
    }>
    // Reconstruct resolution VARIANTS from the raw per-collection files: `deduped` keeps one
    // file per modId, but the raw collections may hold the same mod in 2K AND 4K.
    const rawByMod = new Map<number, Array<{ fileId: number; name: string; md5?: string; fileSize?: number }>>()
    for (const c of (b.collections ?? []) as Array<{
      mods?: Array<{ modId: number; fileId: number; name: string; md5?: string; fileSize?: number }>
    }>) {
      for (const rm of c.mods ?? []) {
        if (!rm?.modId || !rm?.fileId) continue
        const list = rawByMod.get(rm.modId) ?? []
        list.push({ fileId: rm.fileId, name: rm.name, md5: rm.md5, fileSize: rm.fileSize })
        rawByMod.set(rm.modId, list)
      }
    }
    // NB: niente pre-filtro silenzioso su modId/fileId — le entry malformate le scarta (e le
    // RIPORTA) validateDownloadSchema in sanitizeSyncSource, così il log dice cosa manca e perché.
    return arr.map((m) => {
      const variants = buildVariants(rawByMod.get(m.modId) ?? [])
      // Attach only when there's a REAL choice (≥2 resolutions).
      return variants.length > 1
        ? { modId: m.modId, fileId: m.fileId, name: m.name, md5: m.md5, fileSize: m.fileSize, variants }
        : { modId: m.modId, fileId: m.fileId, name: m.name, md5: m.md5, fileSize: m.fileSize }
    })
  }

  /** Collezioni marcate come potate (persistite dal comando catalog:prune-collection). */
  const readPrunedCollections = (): string[] => {
    const v = store.get('prunedCollections')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  }

  /** Grafo `requires` del catalogo (nexus_id → deps). Vuoto se DB assente o righe malformate. */
  const catalogRequiresMap = (): Map<number, number[]> => {
    const map = new Map<number, number[]>()
    try {
      if (!db) return map
      const rows = getRawDb().prepare('SELECT nexus_id, requires FROM modlist_catalog').all() as Array<{
        nexus_id: number
        requires: string | null
      }>
      for (const r of rows) {
        try {
          const arr = JSON.parse(r.requires ?? '[]')
          if (Array.isArray(arr)) {
            const deps = arr.map(Number).filter((n) => Number.isInteger(n) && n > 0)
            if (deps.length) map.set(r.nexus_id, deps)
          }
        } catch {
          /* riga malformata: nessuna dipendenza dichiarata */
        }
      }
    } catch {
      /* DB non pronto: il chiamante degrada in fail-safe */
    }
    return map
  }

  /**
   * Sanificazione fail-safe della sorgente sync:
   *  1) schema download (validateDownloadSchema): entry senza modId/fileId o con md5 malformato
   *     vengono FLAGGATE nei log ed ESCLUSE dalla coda (un fetch senza link diretto derivabile
   *     finirebbe in timeout/retry a vuoto);
   *  2) collezioni potate (prunedCollections): il piano viene RICALCOLATO a ogni load sul backup
   *     corrente (esclusività raw + dependency-keep sul grafo requires) — niente id hardcoded.
   */
  const sanitizeSyncSource = (
    mods: SyncMod[],
    backup: BackupCollectionsLike | null,
  ): SyncMod[] => {
    const { valid, invalid, warnings } = validateDownloadSchema(mods)
    if (invalid.length)
      logger.warn(
        'sync',
        `schema download: ${invalid.length} entry invalide escluse dalla coda — ${summarizeInvalid(invalid)}`,
      )
    if (warnings.length)
      logger.warn('sync', `schema download: ${warnings.length} entry con anomalie soft — ${summarizeInvalid(warnings)}`)
    let out = valid
    const pruned = readPrunedCollections()
    if (pruned.length && backup) {
      const requires = catalogRequiresMap()
      for (const q of pruned) {
        const plan = computePrunePlan(backup, q, requires)
        if (isPruneError(plan)) {
          logger.warn('sync', `pruning "${q}" saltato (fail-safe): ${plan.error}`)
          continue
        }
        const drop = new Set(plan.prunedIds)
        const before = out.length
        out = out.filter((m) => !drop.has(m.modId))
        logger.info(
          'sync',
          `pruning collezione "${plan.collection}": ${before - out.length} mod escluse (${plan.keptAsDependencyIds.length} tenute come dipendenze, ${plan.sharedIds.length} condivise con altre collezioni)`,
        )
      }
    } else if (pruned.length) {
      logger.warn('sync', 'pruning collezioni saltato (fail-safe): backup raw non disponibile')
    }
    return out
  }

  // Source of truth: the persisted backup (survives a Vortex wipe); fallback to a live scan.
  const loadSyncMods = (): SyncMod[] => {
    const raw = readBackupRaw()
    if (raw) {
      const mods = backupToSyncMods(raw.backup)
      if (mods.length) {
        const out = sanitizeSyncSource(mods, raw.backup)
        logger.info('sync', `sorgente: backup ${raw.path} (${out.length} mod)`)
        return out
      }
    }
    // fallback: live Vortex scan (no variant reconstruction — a live scan has one file per mod)
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
      const out = sanitizeSyncSource(mods, null)
      logger.info('sync', `sorgente: scan Vortex (${out.length} mod)`)
      return out
    }
    return []
  }

  // Selezione del blocco Run-Prog: senza limit → tutta la lista; con limit → le
  // prossime N mod il cui dir di estrazione non esiste ancora (progressione reale).
  // NB: va chiamata su una lista già PROFILE-RESOLVED — i dir di estrazione derivano dal nome della
  // variante scelta (2K/4K), quindi il check sul nome raw ri-selezionerebbe per sempre le mod
  // variante già installate (Run-Prog non progredirebbe mai oltre quelle).
  const selectSyncBlock = (all: SyncMod[], stockDir: string, limit?: number): SyncMod[] => {
    const lim = Math.floor(Number(limit)) // sanitize: NaN/frazioni/negativi dal renderer → lista intera
    if (!Number.isFinite(lim) || lim <= 0) return all
    const modsDir = stockGameModsDir(stockDir)
    return all.filter((m) => !existsSync(modDestDir(modsDir, m))).slice(0, lim)
  }

  // Pipeline di pianificazione CONDIVISA tra sync:start e sync:preflight: stessa base list
  // (traduzioni escluse), stessa selezione del blocco su nomi profile-resolved, stessa stima
  // dipendenze-espansa e stessa decisione fail-closed. La card GO/NO-GO e il gate di avvio non
  // possono più divergere su numeri o verdetto. Preflight resta READ-ONLY (persistTranslations
  // solo su un avvio reale); la mappa in-memory delle coppie tiene i due percorsi identici.
  const buildSyncPlan = async (limit?: number, o?: { persistTranslations?: boolean }) => {
    const stockDir = resolveStockTarget()
    const all = loadSyncMods()
    const profile = syncTextureProfile()
    const enableAutoTranslate = store.get('enableAutoTranslate') !== false // default ON
    const translationByBase = new Map<number, number>()
    const translationIds = new Set<number>()
    if (enableAutoTranslate && all.length) {
      try {
        const pairs = pairBackupTranslations(
          all.map((m) => ({ modId: m.modId, name: m.name, fileId: m.fileId, md5: m.md5 })),
        )
        if (o?.persistTranslations && pairs.length) {
          saveTranslations(requireDb(), pairs, 'backup')
          logger.info('sync', `traduzioni ITA mappate dal backup: ${pairs.length} (escluse dalla lista base)`)
        }
        for (const p of pairs) {
          translationIds.add(p.translation_nexus_id)
          translationByBase.set(p.base_nexus_id, p.translation_nexus_id)
        }
      } catch (e) {
        logger.warn('sync', `mappatura traduzioni fallita (proseguo senza): ${(e as Error).message}`)
      }
    }
    const baseList = translationIds.size ? all.filter((m) => !translationIds.has(m.modId)) : all
    // Run-Prog: con un limit il blocco è composto dalle prossime N mod NON ancora presenti nello
    // StockGame (non le prime N della lista, che dopo il primo run sarebbero tutte skip).
    const mods = selectSyncBlock(resolveMods(baseList, profile), stockDir, limit)
    const downloadsDir = join(app.getPath('userData'), 'downloads')
    const translationIdOf = enableAutoTranslate
      ? (baseId: number) => translationByBase.get(baseId) ?? null
      : undefined
    const req = computeRequiredSpace({
      db: db ? requireDb() : null,
      mods: all, // full backup list ⇒ pulled-in dependencies (and translations) can still be sized
      targetIds: mods.map((m) => m.modId),
      stockGameDir: stockDir,
      exists: existsSync,
      profile,
      translationIdOf,
    })
    const freeBytes = await getFreeSpace(stockDir)
    const sameDisk = sameVolume(downloadsDir, stockDir)
    // Cross-disk: anche il volume della cache download deve reggere gli archivi (che vengono
    // RITENUTI per tutto il run) — altrimenti il gate passa sul disco StockGame e C: si riempie.
    const downloadsFreeBytes = sameDisk ? null : await getFreeSpace(downloadsDir)
    const decision = decideDiskGate({
      required: req,
      freeBytes,
      sameDisk,
      downloadsFreeBytes,
      ...syncFactors(),
    })
    return { stockDir, all, mods, profile, enableAutoTranslate, req, freeBytes, sameDisk, downloadsDir, decision }
  }

  let syncAbort: AbortController | null = null
  let syncState: SyncProgress | null = null
  ipcMain.handle('sync:start', async (_e, opts?: { concurrency?: number; limit?: number }) => {
    if (syncAbort) return { ok: false, error: 'Sincronizzazione già in corso' }
    if (!nexusEnabled() || !(readSecret('nexusApiKey') || '').trim()) {
      return {
        ok: false,
        error:
          'Nexus non attivo: inserisci la chiave Premium e abilita il download reale nelle Impostazioni.',
      }
    }
    // ── Pre-flight disk gatekeeper (PRECHECK-02) — FAIL-CLOSED, BEFORE the queue starts ──────────
    // Re-entrancy lock BEFORE the first await: a second sync:start dispatched during qualsiasi await
    // sotto vede syncAbort non-null e viene rifiutata. Il lock è rilasciato su OGNI uscita che non
    // avvia la coda — inclusi i throw (altrimenti la sync resterebbe bloccata fino al riavvio).
    syncAbort = new AbortController()
    let plan: Awaited<ReturnType<typeof buildSyncPlan>>
    try {
      plan = await buildSyncPlan(opts?.limit, { persistTranslations: true })
    } catch (e) {
      syncAbort = null
      const emsg = (e as Error).message
      logger.error('sync', `pre-flight sync fallito: ${emsg}`)
      return { ok: false, error: `Pre-flight non riuscito: ${emsg}` }
    }
    const { stockDir, all, mods, profile, enableAutoTranslate, req, freeBytes, sameDisk, downloadsDir, decision } =
      plan
    if (!all.length) {
      syncAbort = null
      return { ok: false, error: 'Nessun mod da sincronizzare (backup e scan Vortex vuoti).' }
    }
    if (!mods.length) {
      syncAbort = null
      return { ok: false, error: 'Tutte le mod risultano già sincronizzate nello StockGame.' }
    }
    if (db && !req.usedDependencyGraph) {
      logger.warn('sync', 'catalogo dipendenze non usabile: stima spazio sul solo blocco (nessuna espansione deps)')
    }
    const steam = resolveGameSource()
    // Clamp ANCHE il valore dal renderer (non solo il default dallo store): il renderer è untrusted
    // e 999 worker sarebbero un resource-exhaustion, non una preferenza.
    const requestedConc = Math.floor(Number(opts?.concurrency))
    const concurrency = Math.max(
      1,
      Math.min(
        8,
        Number.isFinite(requestedConc) && requestedConc > 0
          ? requestedConc
          : Number(store.get('downloadThreads')) || 4,
      ),
    )
    // '—' per non-finito: getFreeSpace ritorna Infinity su volume non sondabile — mai stampare
    // "liberi Infinity GB" in log/toast.
    const gb = (b: number) => (Number.isFinite(b) ? (b / 1024 ** 3).toFixed(1) : '—')
    if (!decision.ok) {
      syncAbort = null // the queue never started — free the lock so a corrected retry can run
      // Se il volume StockGame ha passato entrambi i modelli, il blocco viene dal SECONDO volume
      // (cache download cross-disk): il messaggio deve puntare al disco giusto.
      const cacheBlocked =
        decision.downloadsFreeBytes != null && decision.gate.ok && decision.preflight.ok
      const diskError = {
        reason: decision.reason,
        requiredBytes: decision.requiredBytes,
        requiredWithBufferBytes: decision.gate.requiredWithBuffer,
        freeBytes,
        missingBytes: decision.missingBytes,
        savingBytes: req.savingBytes,
        requiredGB: gb(decision.requiredBytes),
        freeGB: gb(freeBytes),
        missingGB: gb(decision.missingBytes),
        profile,
        pendingMods: req.plannedIds.length,
        extraDeps: req.extraDepIds.length,
        unsizedCount: decision.unsizedTargets.length,
        sameDisk,
        cacheDisk: cacheBlocked,
        downloadsFreeBytes: decision.downloadsFreeBytes,
        downloadsRequiredBytes: decision.downloadsRequiredBytes,
      }
      const msg =
        decision.reason === 'unsized'
          ? `Impossibile verificare lo spazio: ${decision.unsizedTargets.length} mod senza dimensione nota nel backup. Rigenera il backup delle collezioni (o riduci il blocco con Run-Prog) prima di avviare il mass-install.`
          : decision.reason === 'unreadable'
            ? `Impossibile leggere lo spazio libero sul volume ${cacheBlocked ? `della cache download (${downloadsDir})` : `dello StockGame (${stockGameModsDir(stockDir)})`}. Verifica che il disco sia connesso e accessibile, poi riprova.`
            : cacheBlocked
              ? `Spazio insufficiente sul volume della cache download (${downloadsDir}): gli archivi del run occupano ~${gb(decision.downloadsRequiredBytes)} GB (incluso margine), liberi ${gb(decision.downloadsFreeBytes ?? 0)} GB → mancano ${gb(decision.missingBytes)} GB su quel volume. Libera spazio lì o sposta la cartella download.`
              : `Spazio su disco insufficiente: servono ~${diskError.requiredGB} GB (download ${gb(req.requiredBytes)} GB + margine estrazione${sameDisk ? ', stesso disco' : ''}), liberi ${diskError.freeGB} GB → mancano ${diskError.missingGB} GB. Libera spazio, sposta lo StockGame su un volume più capiente${profile === '4K' ? ' o passa al profilo texture 2K' : ''}.`
      logger.error('sync', msg)
      // Pre-flight block: nothing started, so DON'T drive the progress 'error' card (that reads as an
      // interrupted run and leaves a stale error in syncState). The dedicated sync:disk-error channel
      // and the return value carry the block instead — same payload on both so the banner text is
      // identical whichever the renderer sees first.
      const diskPayload = { ...diskError, error: msg }
      mainWindow?.webContents.send('sync:disk-error', diskPayload)
      return { ok: false, error: msg, disk: diskPayload }
    }
    logger.info(
      'sync',
      `Gatekeeper disco OK: download ~${gb(req.requiredBytes)} GB (richiesti ${gb(decision.requiredBytes)} GB col margine), liberi ${gb(freeBytes)} GB` +
        `${req.translationBytes > 0 ? ` · traduzioni ITA ${gb(req.translationBytes)} GB` : ''}` +
        `${req.savingBytes > 0 ? ` · profilo ${profile} risparmia ${gb(req.savingBytes)} GB vs 4K` : ''}` +
        `${req.extraDepIds.length ? ` · ${req.extraDepIds.length} dipendenze incluse` : ''}`,
    )

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
      textureProfile: profile,
      // NB: the main gate above already fail-closed on the dependency-EXPANDED footprint (a superset
      // of this selection), so runMassSync's own pre-flight can only ever agree — we keep it ON as a
      // second, independent fail-closed layer (defense-in-depth) rather than skipping it.
      // Step 3 — two-phase install: when a base mod has an ITA mapping, the worker downloads and
      // overlays the translation into the same dir on the SAME queue slot (fail-soft if it errors).
      enableAutoTranslate,
      translationOf: enableAutoTranslate
        ? (modId: number) => {
            const t = resolveTranslation(requireDb(), modId, 'it')
            return t
              ? { nexus_id: t.translation_nexus_id, file_id: t.translation_file_id, md5: t.translation_md5 }
              : null
          }
        : undefined,
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
        // Ponte mass-sync → tabella mods: ogni estrazione presente su disco viene registrata come
        // mod INSTALLATA del profilo attivo. Senza questo il Deploy (che legge mods.is_installed)
        // non vedrà mai ciò che il mass-installer ha estratto nello StockGame.
        try {
          const modsDirNow = stockGameModsDir(stockDir)
          const candidates: InstalledCandidate[] = mods
            .filter((m) => existsSync(modDestDir(modsDirNow, m)))
            .map((m) => ({
              modId: m.modId,
              name: m.name,
              installPath: modDestDir(modsDirNow, m),
              fileSize: m.fileSize,
            }))
          const reg = registerInstalledMods(requireDb(), resolveActiveProfileId(getRawDb(), store), candidates)
          logger.info(
            'sync',
            `registrazione mods: ${reg.inserted} nuove, ${reg.updated} aggiornate, ${reg.unchanged} già registrate`,
          )
        } catch (e) {
          logger.warn('sync', `registrazione mods fallita (il deploy non vedrà queste estrazioni): ${(e as Error).message}`)
        }
        // Step 3 — post-list ESL/254 scan. Skyrim won't launch with >254 FULL plugins; ESL /
        // ESL-flagged plugins are free. The verdict is SENT TO THE RENDERER on a dedicated channel:
        // a log-file-only escalation defeated the feature's whole purpose (the user saw a green
        // success toast while the game could not launch).
        try {
          const budget = scanInstalledPluginBudget(stockGameModsDir(stockDir))
          const line = `plugin budget: ${budget.full} mod + ${budget.reservedSlots} vanilla su ${budget.limit} full · ${budget.light} light (ESL) liberi`
          if (budget.overBudget) {
            logger.error(
              'sync',
              `⚠ LIMITE PLUGIN SUPERATO — ${line}. Skyrim non partirà: converti in ESL o rimuovi ${-budget.remaining} plugin full.`,
            )
          } else {
            logger.info('sync', `${line} — entro il limite (${budget.remaining} slot full liberi)`)
          }
          mainWindow?.webContents.send('sync:plugin-budget', budget)
        } catch (e) {
          logger.warn('sync', `scan plugin budget fallita: ${(e as Error).message}`)
        }
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
  // STESSA pipeline di sync:start (buildSyncPlan, read-only): base list senza traduzioni, blocco
  // profile-resolved, footprint dipendenze-espanso e decisione fail-closed identica. La card non
  // può più mostrare "✓ GO" mentre il click viene bloccato dal gate con numeri diversi.
  ipcMain.handle('sync:preflight', async (_e, opts?: { limit?: number }) => {
    const plan = await buildSyncPlan(opts?.limit)
    const d = plan.decision
    const pf = d.preflight
    return {
      // Campi storici della card, ora derivati dalla STESSA decisione del gate di avvio.
      pendingBytes: pf.pendingBytes,
      extractionOverhead: pf.extractionOverhead,
      safetyFactor: pf.safetyFactor,
      sameDisk: pf.sameDisk,
      requiredBytes: d.requiredBytes, // requisito vincolante (identico al banner del gate)
      freeBytes: d.freeBytes,
      minFreeMarginBytes: pf.minFreeMarginBytes,
      marginBytes: (Number.isFinite(d.freeBytes) ? d.freeBytes : 0) - d.requiredBytes,
      ok: d.ok,
      stockGameDir: plan.stockDir,
      modsTotal: plan.all.length,
      modsSelected: plan.mods.length,
      textureProfile: plan.profile,
      // Verdetto unificato del gate (nuovo): la card può spiegare PERCHÉ, come il banner.
      reason: d.reason,
      missingBytes: d.missingBytes,
      unsizedCount: d.unsizedTargets.length,
      extraDeps: plan.req.extraDepIds.length,
      savingBytes: plan.req.savingBytes,
      translationBytes: plan.req.translationBytes,
      cacheDisk: d.downloadsFreeBytes != null && d.gate.ok && d.preflight.ok && !d.ok,
    }
  })

  // Backfill: registra nella tabella mods TUTTE le estrazioni già presenti nello StockGame che
  // appartengono alla sorgente sync corrente (pruning + validazione schema inclusi — i leftover
  // DOMAIN su disco NON vengono registrati). Copre le estrazioni storiche fatte PRIMA del ponte
  // mass-sync→mods. Prova sia il nome profile-resolved sia quello raw del backup (le estrazioni
  // pre-texture-profile usavano il nome raw).
  ipcMain.handle('sync:register-installed', () => {
    try {
      const stockDir = resolveStockTarget()
      const modsDirNow = stockGameModsDir(stockDir)
      const all = loadSyncMods() // già sanificata (schema download + collezioni potate)
      const resolved = resolveMods(all, syncTextureProfile())
      const byId = new Map(all.map((m) => [m.modId, m]))
      const candidates: InstalledCandidate[] = []
      for (const m of resolved) {
        const dir = modDestDir(modsDirNow, m)
        if (existsSync(dir)) {
          candidates.push({ modId: m.modId, name: m.name, installPath: dir, fileSize: m.fileSize })
          continue
        }
        const raw = byId.get(m.modId)
        if (raw && raw.name !== m.name) {
          const rawDir = modDestDir(modsDirNow, raw)
          if (existsSync(rawDir))
            candidates.push({ modId: raw.modId, name: raw.name, installPath: rawDir, fileSize: raw.fileSize })
        }
      }
      const reg = registerInstalledMods(requireDb(), resolveActiveProfileId(getRawDb(), store), candidates)
      logger.info(
        'sync',
        `registrazione estratte: ${candidates.length} trovate su disco → ${reg.inserted} nuove, ${reg.updated} aggiornate, ${reg.unchanged} invariate`,
      )
      return { ok: true, found: candidates.length, ...reg }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── Sanificazione catalogo: pruning collezione + validazione schema download ────────────────
  // Piano di potatura di una collezione (es. "DOMAIN"): dry-run di default, `apply=true` esegue.
  // Regole nel modulo puro collectionPrune.ts: rimozione SOLO delle mod esclusive della collezione,
  // con dependency-keep transitivo sul grafo requires (niente missing masters tra i superstiti).
  ipcMain.handle('catalog:prune-collection', (_e, query: unknown, apply?: unknown) => {
    const q = typeof query === 'string' ? query.trim() : ''
    if (!q) return { ok: false, error: 'Nome collezione mancante' }
    const raw = readBackupRaw()
    if (!raw)
      return { ok: false, error: 'Backup collezioni non trovato: impossibile calcolare il piano in sicurezza.' }
    const plan = computePrunePlan(raw.backup, q, catalogRequiresMap())
    if (isPruneError(plan)) return { ok: false, error: plan.error }
    let catalogRowsDeleted = 0
    let downloadsDeleted = 0
    if (apply === true && plan.prunedIds.length) {
      try {
        const rdb = getRawDb()
        const CHUNK = 500 // sotto il limite di 999 variabili SQLite
        const tx = rdb.transaction(() => {
          for (let i = 0; i < plan.prunedIds.length; i += CHUNK) {
            const ch = plan.prunedIds.slice(i, i + CHUNK)
            const ph = ch.map(() => '?').join(',')
            // Solo le righe importate di QUELLA collezione: una voce curata resta anche a pari id.
            catalogRowsDeleted += rdb
              .prepare(`DELETE FROM modlist_catalog WHERE category = ? AND nexus_id IN (${ph})`)
              .run(plan.collection, ...ch).changes
            // Coda download: si annullano solo gli stati non ancora attivi (mai un run in corso).
            downloadsDeleted += rdb
              .prepare(`DELETE FROM downloads WHERE status IN ('queued','pending') AND nexus_id IN (${ph})`)
              .run(...ch).changes
          }
        })
        tx()
      } catch (e) {
        return { ok: false, error: `Pulizia DB fallita: ${(e as Error).message}` }
      }
      // Persisti la scelta: loadSyncMods ricalcola ed esclude a ogni load (reversibile svuotando
      // il setting; le righe catalogo tornano col bottone "Importa modlist Vortex").
      const cur = readPrunedCollections()
      if (!cur.includes(plan.collection)) store.set('prunedCollections', [...cur, plan.collection])
      logger.info(
        'catalog',
        `pruning "${plan.collection}": ${plan.prunedIds.length} mod escluse dalla sync, ${catalogRowsDeleted} righe catalogo rimosse, ${downloadsDeleted} download in coda annullati; ${plan.keptAsDependencyIds.length} esclusive tenute come dipendenze, ${plan.sharedIds.length} condivise`,
      )
    }
    return {
      ok: true,
      applied: apply === true,
      collection: plan.collection,
      exclusive: plan.exclusiveIds.length,
      shared: plan.sharedIds.length,
      keptAsDependency: plan.keptAsDependencyIds.length,
      pruned: plan.prunedIds.length,
      catalogRowsDeleted,
      downloadsDeleted,
    }
  })

  // Data-integrity check dello schema download su coda residua + catalogo. Fail-safe: flagga e
  // riporta, non cancella mai. Backfill idempotente di nexus_file_id dal backup (la colonna
  // esisteva dalla migrazione 3 ma l'import Vortex non la popolava → senza, ogni riga importata
  // risulterebbe missing-url pur avendo il fileId nel backup).
  ipcMain.handle('catalog:validate-downloads', () => {
    const raw = readBackupRaw()
    let queue: {
      total: number
      valid: number
      invalidCount: number
      warningCount: number
      invalid: unknown[]
      warnings: unknown[]
    } | null = null
    if (raw) {
      const all = backupToSyncMods(raw.backup)
      const v = validateDownloadSchema(all)
      queue = {
        total: all.length,
        valid: v.valid.length,
        invalidCount: v.invalid.length,
        warningCount: v.warnings.length,
        invalid: v.invalid.slice(0, 50),
        warnings: v.warnings.slice(0, 50),
      }
      if (v.invalid.length)
        logger.warn('catalog', `validazione coda: ${v.invalid.length} entry invalid/missing-url — ${summarizeInvalid(v.invalid)}`)
    }
    let backfilled = 0
    let catalog: {
      checked: number
      ok: number
      missingUrlCount: number
      badModIdCount: number
      missingUrl: unknown[]
    } | null = null
    try {
      const rdb = getRawDb()
      if (raw) {
        const fileIdOf = new Map<number, number>()
        for (const m of (raw.backup.deduped ?? []) as Array<{ modId?: number; fileId?: number }>) {
          const id = Number(m?.modId)
          const fid = Number(m?.fileId)
          if (Number.isInteger(id) && id > 0 && Number.isInteger(fid) && fid > 0) fileIdOf.set(id, fid)
        }
        const upd = rdb.prepare(
          'UPDATE modlist_catalog SET nexus_file_id = ? WHERE nexus_id = ? AND (nexus_file_id IS NULL OR nexus_file_id <= 0)',
        )
        const tx = rdb.transaction(() => {
          for (const [id, fid] of fileIdOf) backfilled += upd.run(fid, id).changes
        })
        tx()
      }
      const rows = rdb
        .prepare('SELECT nexus_id, name, nexus_file_id, nexus_download_url FROM modlist_catalog')
        .all() as Array<{
        nexus_id: number | null
        name: string | null
        nexus_file_id: number | null
        nexus_download_url: string | null
      }>
      const rep = validateCatalogLinks(rows)
      catalog = {
        checked: rep.checked,
        ok: rep.ok,
        missingUrlCount: rep.missingUrl.length,
        badModIdCount: rep.badModId.length,
        missingUrl: rep.missingUrl.slice(0, 50),
      }
      if (rep.missingUrl.length)
        logger.warn(
          'catalog',
          `validazione catalogo: ${rep.missingUrl.length}/${rep.checked} righe flaggate missing-url (né nexus_file_id né nexus_download_url)`,
        )
      if (backfilled) logger.info('catalog', `backfill nexus_file_id dal backup: ${backfilled} righe aggiornate`)
    } catch (e) {
      logger.warn('catalog', `validazione catalogo fallita (fail-safe, solo report): ${(e as Error).message}`)
    }
    return { ok: true, backfilled, queue, catalog }
  })

  // ── Svuotamento TOTALE del catalogo ──────────────────────────────────────────
  // Richiesta esplicita: rimuovere l'INTERA modlist (catalogo, coda download, righe
  // mods del profilo). Non tocca i file estratti su disco né l'istanza deployata
  // (per quella c'è deploy:purge). Disattiva anche l'auto-seed del bundle curato:
  // senza il flag, Catalog.tsx ri-seminerebbe le ~122 mod bundled al primo mount su
  // DB vuoto e il wipe non sarebbe mai definitivo. Reversibile: "Importa modlist
  // Vortex" / "Aggiorna catalogo" ripopolano e riattivano il seed.
  ipcMain.handle('catalog:wipe', () => {
    try {
      const rdb = getRawDb()
      const counts = { catalog: 0, downloads: 0, mods: 0, releases: 0 }
      const tx = rdb.transaction(() => {
        // Figli prima (FK senza cascade): delta_changeset → downloads → mods.
        rdb.prepare('DELETE FROM delta_changeset').run()
        counts.downloads = rdb.prepare('DELETE FROM downloads').run().changes
        counts.mods = rdb.prepare('DELETE FROM mods').run().changes
        counts.catalog = rdb.prepare('DELETE FROM modlist_catalog').run().changes
        counts.releases = rdb.prepare('DELETE FROM catalog_release').run().changes // cascade su release_mod
      })
      tx()
      store.set('catalogSeedDisabled', true)
      logger.info(
        'catalog',
        `wipe totale: ${counts.catalog} righe catalogo, ${counts.downloads} download, ${counts.mods} mod eliminate; auto-seed bundle disattivato`,
      )
      return { ok: true, ...counts }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
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

// Igiene WAL alla chiusura (sqlite.org/pragma): checkpoint TRUNCATE + refresh statistiche
// del planner — il file -wal non resta grande tra le sessioni e l'avvio successivo non
// paga il recovery. Fail-soft dentro checkpointOnQuit: mai bloccare l'uscita.
app.on('before-quit', () => {
  if (db) checkpointOnQuit(db as unknown as SqliteDb)
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
    if (!store.has(k)) continue
    // Migrate into the encrypted DB only if it isn't already there.
    if (!hasSecret(db as unknown as SqliteDb, k)) {
      const plain = decryptSecret(store.get(k))
      if (typeof plain === 'string' && plain) setSecret(db as unknown as SqliteDb, k, plain, secretCrypto)
    }
    // ALWAYS purge the legacy electron-store copy when present — a value that lingered here
    // while the DB already had the secret would otherwise stay on disk (older builds wrote it
    // in plaintext). The delete must not be gated on the "not yet migrated" branch.
    store.delete(k as never)
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
  // SRB-001: security-relevant PATH settings (gamePath/mo2Path/tool exes) feed filesystem
  // resolution and process spawning. Reject a UNC / non-absolute / control-char value so a
  // compromised renderer cannot repoint the launcher at a remote or crafted executable.
  const writeCheck = validateSettingWrite(key, value)
  if (!writeCheck.ok) {
    logger.warn('security', `settings:set rifiutato per "${key}" (${writeCheck.reason})`)
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
  // Dopo catalog:wipe l'utente vuole un catalogo VUOTO: l'auto-seed del bundle resta
  // spento finché un'azione esplicita (import Vortex) non riattiva il flag.
  if (store.get('catalogSeedDisabled') === true) {
    logger.info('catalog', `catalog:seed rifiutato (auto-seed disattivato) — ${mods.length} righe scartate`)
    return { inserted: 0, disabled: true }
  }
  logger.info('catalog', `catalog:seed: inserimento/refresh di ${mods.length} righe bundle`)
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

// Import the FULL de-duplicated modlist (~4568 "compatible" mods) from the Vortex collections
// backup into modlist_catalog, so the Catalog page reflects the real modlist and not just the
// ~122 bundled essentials. INSERT OR IGNORE: adds the modlist WITHOUT overwriting curated rows
// (a nexus_id already present keeps its rich metadata). Reuses the same backup path resolution as
// mass-sync (settings override → userData → cwd/data).
ipcMain.handle('catalog:import-vortex', () => {
  const candidates = [
    store.get('collectionsBackupPath') as string | undefined,
    join(app.getPath('userData'), 'vortex-collections-backup.json'),
    join(process.cwd(), 'data', 'vortex-collections-backup.json'),
  ].filter(Boolean) as string[]
  let backup: unknown = null
  let src = ''
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        backup = JSON.parse(readFileSync(p, 'utf8'))
        src = p
        break
      }
    } catch {
      /* try next candidate */
    }
  }
  if (!backup) return { success: false, error: 'Backup Vortex non trovato (vortex-collections-backup.json)' }
  const rows = buildCatalogRowsFromBackup(backup)
  if (!rows.length) return { success: false, error: 'Nessuna mod valida nel backup Vortex' }

  const db = getRawDb()
  const before = (db.prepare('SELECT COUNT(*) AS c FROM modlist_catalog').get() as { c: number }).c
  const insert = db.prepare(`
    INSERT OR IGNORE INTO modlist_catalog
    (nexus_id, nexus_file_id, name, category, subcategory, priority_order, required, description, author, tags, size_mb, has_it_translation, notes, conflicts_with, requires)
    VALUES (@nexus_id, @nexus_file_id, @name, @category, @subcategory, @priority_order, @required, @description, @author, @tags, @size_mb, @has_it_translation, @notes, @conflicts_with, @requires)
  `)
  const tx = db.transaction((rs: ReturnType<typeof buildCatalogRowsFromBackup>) => {
    for (const r of rs) insert.run(r as unknown as Record<string, unknown>)
  })
  tx(rows)
  // Remove cross-source name duplicates (curated placeholder-id row vs the Vortex real-id row),
  // so a fresh import lands a clean list. Within-Vortex generic-name collisions are left intact.
  const deduped = removeVortexNameDuplicates(db)
  const after = (db.prepare('SELECT COUNT(*) AS c FROM modlist_catalog').get() as { c: number }).c
  const imported = after + deduped - before
  logger.info(
    'catalog',
    `import Vortex: ${rows.length} candidati → ${imported} nuovi, ${deduped} doppioni rimossi (totale ${after}) da ${src}`,
  )
  // Ripopolamento esplicito: riattiva l'auto-seed del bundle spento da catalog:wipe.
  store.delete('catalogSeedDisabled')
  return { success: true, candidates: rows.length, imported, deduped, total: after }
})

// ── Import Collection Nexus (v2 GraphQL, fonte ufficiale) ────────────────────────────────────
// A differenza del backup Vortex (JSON locale, id storicamente inaffidabili — vedi seed curato
// che aveva marcato "installate" le mod sbagliate), qui modId/fileId arrivano DIRETTAMENTE dal
// graph Nexus: la coppia è per costruzione corretta e scaricabile.
ipcMain.handle('catalog:import-nexus-collection', async (_e, input: string) => {
  const apiKey = readSecret('nexusApiKey')
  if (!apiKey.trim())
    return { success: false, error: 'Nessuna API key Nexus: impostala nelle Impostazioni prima di importare' }
  const parsed = parseCollectionInput(input)
  if (!parsed)
    return { success: false, error: 'Slug o URL collezione non riconosciuto (es. "abc123" o link nexusmods.com/…/collections/abc123)' }
  let revision: CollectionRevisionResult
  try {
    revision = await fetchCollectionRevision(axiosPostJson, { slug: parsed.slug, revision: parsed.revision, apiKey })
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
  // Guardia namespace: nexus_id è per-gioco, una collezione di un altro titolo corromperebbe
  // il catalogo con id numerici che qui significano tutt'altro.
  if (revision.gameDomain && revision.gameDomain !== 'skyrimspecialedition') {
    return {
      success: false,
      error: `Collezione per "${revision.gameDomain}", non Skyrim Special Edition: import rifiutato`,
    }
  }
  if (!revision.mods.length) return { success: false, error: `Collezione "${revision.collectionName}" senza mod` }

  const rows = buildCatalogRowsFromCollection(revision)
  const db = getRawDb()
  const before = (db.prepare('SELECT COUNT(*) AS c FROM modlist_catalog').get() as { c: number }).c
  const insert = db.prepare(`
    INSERT OR IGNORE INTO modlist_catalog
    (nexus_id, nexus_file_id, name, category, subcategory, priority_order, required, description, author, tags, size_mb, has_it_translation, notes, conflicts_with, requires)
    VALUES (@nexus_id, @nexus_file_id, @name, @category, @subcategory, @priority_order, @required, @description, @author, @tags, @size_mb, @has_it_translation, @notes, @conflicts_with, @requires)
  `)
  const tx = db.transaction((rs: typeof rows) => {
    for (const r of rs) insert.run(r as unknown as Record<string, unknown>)
  })
  tx(rows)
  const deduped = removeVortexNameDuplicates(db)
  const after = (db.prepare('SELECT COUNT(*) AS c FROM modlist_catalog').get() as { c: number }).c
  const imported = after + deduped - before
  logger.info(
    'catalog',
    `import Collection Nexus "${revision.collectionName}" rev.${revision.revisionNumber}: ${rows.length} candidati → ${imported} nuovi, ${deduped} doppioni rimossi (totale ${after})`,
  )
  store.delete('catalogSeedDisabled')
  return {
    success: true,
    collectionName: revision.collectionName,
    revisionNumber: revision.revisionNumber,
    candidates: rows.length,
    imported,
    deduped,
    total: after,
  }
})

// Standalone dedupe for a catalog that already contains the cross-source duplicates (e.g. imported
// before this fix). Removes the curated placeholder-id row when a Vortex real-id row shares its name.
ipcMain.handle('catalog:dedupe', () => {
  const removed = removeVortexNameDuplicates(getRawDb())
  const total = (getRawDb().prepare('SELECT COUNT(*) AS c FROM modlist_catalog').get() as { c: number }).c
  logger.info('catalog', `dedupe catalogo: ${removed} doppioni rimossi (totale ${total})`)
  return { success: true, removed, total }
})

// ─── Downloads IPC ────────────────────────────────────────────────────────────
// Statement preparato UNA volta e riusato: questo è l'unico handler in polling ciclico
// (la pagina Download lo chiama ogni 3s) — ripreparare a ogni tick paga parse/plan
// inutili (better-sqlite3 non ha una statement cache implicita). Lazy: la prima
// chiamata arriva sempre DOPO init+migrazioni, lo schema è definitivo.
let downloadsListStmt: ReturnType<Database.Database['prepare']> | null = null
ipcMain.handle('downloads:list', (_e, profileId: number) => {
  // Explicit column list (NOT SELECT *): the nxm_key / nxm_expires non-premium download
  // token is a short-lived secret used only main-side and must never reach the renderer.
  downloadsListStmt ??= getRawDb().prepare(
    `SELECT id, mod_id, profile_id, nexus_id, file_id, name, url, file_path,
            total_size, downloaded_size, status, error, created_at
     FROM downloads WHERE profile_id = ? ORDER BY created_at DESC`,
  )
  return downloadsListStmt.all(profileId)
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
//
// Only the APP-MANAGED, non-store-tunable kinds are listable (backups/downloads/logs — always
// under userData). The user-configured kinds (game/mo2/mods/stockGame/instances) resolve through
// store paths a compromised renderer can repoint via settings:set, which would turn read-dir back
// into an arbitrary-directory oracle; they are refused here at the source.
const READDIR_KINDS = new Set(['backups', 'downloads', 'logs'])
ipcMain.handle('fs:read-dir', async (_e, kind: string, subpath?: string) => {
  if (!READDIR_KINDS.has(kind)) {
    logger.warn('security', `fs:read-dir rifiutato (kind non elencabile): ${String(kind).slice(0, 40)}`)
    return { ok: false, error: 'Cartella non disponibile', entries: [] }
  }
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
          : // lstat (no-follow): a symlink entry reports the LINK's own size, never the size
            // or existence of an out-of-root target it points at (info-leak defense).
            await lstat(join(decision.path, d.name))
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
  // A completed download ALWAYS lives under the app-managed userData/downloads dir (the download
  // manager writes only there). Confine to that ONE non-store-tunable root — validating against
  // the full revealRoots() would let a renderer widen a root via settings:set and reveal any file.
  const downloadsDir = join(app.getPath('userData'), 'downloads')
  const decision = validateInsideRoot(row.file_path, downloadsDir, revealProbe)
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
