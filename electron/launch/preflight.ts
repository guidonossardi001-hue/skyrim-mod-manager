import { execFile } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, lstatSync, chmodSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import type Store from 'electron-store'
import { detectSteamEnv, detectSkse, SKYRIM_SE_APPID } from '../steam/detect'
import { isAddressLibraryBin, addressLibraryMatchesVersion } from './addressLibrary'
import { resolveMo2Plugins } from '../steam/mo2'
import { runLaunchWorkflow, type LaunchEnv, type LaunchReport } from '../../src/lib/launchWorkflow'
import { parsePluginsTxt } from '../../src/lib/compatibility'
import { resolveActiveProfileId } from '../util/activeProfile'
import { sanitizePathSegment } from '../util/paths'
import { readGuardStatus, checkVersionDrift, type UpdateGuardFsOps } from '../steam/updateGuard'
import { verifyDeployedInstance, type VerifyIo } from '../deploy/verifyDeploy'
import { resolveDeployDataDir } from '../deploy/resolveTarget'
import { parseDeployManifest, computeModsFingerprint, DEPLOY_MANIFEST_FILE } from '../deploy/plan'
import { runSaveDoctor, type SaveDoctorIo } from '../saves/saveDoctor'
import { readPluginHeader } from '../plugins/espParser'
import { queryPagefileInfo, evaluatePagefile } from './pagefileCheck'

/** Chiave setting: ultima versione del runtime vista a un lancio riuscito (drift detection). */
export const LAST_GAME_VERSION_KEY = 'lastKnownGameVersion'

/** Chiave setting: cache del probe pagefile (PowerShell/CIM). Lo spawn di powershell.exe
 *  costa ~1-2s ad ogni chiamata (avvio CLR + provider CIM) — il dato che verifica (dimensione
 *  pagefile) cambia solo se l'utente tocca le impostazioni di sistema, mai da un lancio
 *  all'altro. Rieseguire il probe ad OGNI avvio (come faceva prima) è il gap di latenza più
 *  grosso di buildLaunchEnv rispetto a Nolvus, che non fa alcun preflight. TTL 24h: abbastanza
 *  corto da non nascondere un cambio reale, abbastanza lungo da renderlo gratis su ogni lancio. */
export const PAGEFILE_CACHE_KEY = 'pagefileProbeCache'
const PAGEFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface PagefileCacheEntry {
  checkedAt: number
  info: import('./pagefileCheck').PagefileInfo
}

/** FsOps reali dell'update guard (Windows: bit di scrittura ↔ attributo read-only). */
export const realGuardFs: UpdateGuardFsOps = {
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  isReadOnly: (p) => (statSync(p).mode & 0o200) === 0,
  setReadOnly: (p, ro) => chmodSync(p, ro ? 0o444 : 0o644),
}

const verifyIo: VerifyIo = {
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  lstat: (p) => {
    const st = lstatSync(p)
    // isSymbolicLink è OBBLIGATORIO per giudicare le junction: su Windows lstat di una
    // junction sana dà isDirectory() false (reparse point) — senza questo campo tutte
    // le junction risultavano "scollegate" e la riparazione rideployava a ogni avvio.
    return { nlink: st.nlink, isFile: st.isFile(), isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink() }
  },
}

const saveDoctorIo: SaveDoctorIo = {
  exists: existsSync,
  listDir: (p) =>
    readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        let mtimeMs = 0
        try {
          mtimeMs = statSync(join(p, e.name)).mtimeMs
        } catch {
          /* voce illeggibile: resta in coda per mtime */
        }
        return { name: e.name, mtimeMs }
      }),
  readFileBuf: (p) => readFileSync(p),
  readFileText: (p) => readFileSync(p, 'utf8'),
}

/** Cartella standard Documents/My Games/Skyrim Special Edition — dove il runtime legge
 *  SEMPRE Skyrim.ini/SkyrimPrefs.ini (Bethesda la hardcode, indipendente da dove sta la Data). */
export function documentsGameDir(): string {
  return join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition')
}

/** Cartella saves standard del gioco (Documenti/My Games). */
export function defaultSavesDir(): string {
  return join(documentsGameDir(), 'Saves')
}

/** Cartella save EFFETTIVA del profilo attivo: Saves/<profilo sanificato>/ se l'isolamento
 *  per-profilo è attivo (setting `perProfileSaves`, vedi deployer.ts SLocalSavePath) e il
 *  profilo è risolvibile — altrimenti la Saves/ condivisa (comportamento preesistente). Deve
 *  restare in sincrono con la stringa scritta in SLocalSavePath: altrimenti Save Doctor
 *  diagnosticherebbe la cartella SBAGLIATA per un profilo con l'isolamento attivo. */
export function activeSavesDir(db: Database.Database, store: Store): string {
  if (store.get('perProfileSaves') !== true) return defaultSavesDir()
  try {
    const profileId = resolveActiveProfileId(db, store)
    const row = db.prepare('SELECT name FROM profiles WHERE id=?').get(profileId) as
      | { name: string }
      | undefined
    if (row?.name) return join(documentsGameDir(), 'Saves', sanitizePathSegment(row.name, 'profile'))
  } catch {
    /* fail-soft: ricade sulla cartella condivisa */
  }
  return defaultSavesDir()
}

/** plugins.txt DI SISTEMA (%LOCALAPPDATA%) — quello letto dal gioco avviato via SKSE. */
export function systemPluginsTxtPath(): string | null {
  const base = process.env.LOCALAPPDATA
  return base ? join(base, 'Skyrim Special Edition', 'plugins.txt') : null
}

/**
 * Load order REALE del gioco. Il launcher avvia SKSE direttamente: il gioco legge la
 * plugins.txt DI SISTEMA — la stessa che il deploy scrive. Leggere invece quella del
 * profilo MO2 (che non usiamo, e il cui percorso non è nemmeno impostabile) rendeva il
 * check dei plugin CIECO per costruzione: sempre 0 plugin, quindi sempre "sotto il limite".
 * MO2 resta un fallback informativo per installazioni ibride legacy.
 */
export function resolveRealPlugins(mo2Plugins: { name: string; enabled: boolean }[]): {
  plugins: { name: string; enabled: boolean }[]
  source: 'system' | 'mo2' | 'none'
} {
  try {
    const p = systemPluginsTxtPath()
    if (p && existsSync(p)) {
      const parsed = parsePluginsTxt(readFileSync(p, 'utf8'))
      if (parsed.length) return { plugins: parsed, source: 'system' }
    }
  } catch {
    /* illeggibile → si prova il fallback */
  }
  if (mo2Plugins.length) return { plugins: mo2Plugins, source: 'mo2' }
  return { plugins: [], source: 'none' }
}

/** Save Doctor con IO reale — usato dal preflight e dall'IPC `saves:doctor`. `savesDir` di
 *  default alla cartella condivisa (retro-compatibile); i chiamanti profile-aware passano
 *  `activeSavesDir(db, store)` così l'isolamento per-profilo si riflette anche qui. */
export function runSaveDoctorLive(gamePath: string | null, savesDir: string = defaultSavesDir()) {
  return runSaveDoctor(
    {
      savesDir,
      systemPluginsTxt: systemPluginsTxtPath(),
      gameDataDir: gamePath ? join(gamePath, 'Data') : null,
    },
    saveDoctorIo,
  )
}

/** Verifica integrità deploy con IO reale — usata dal preflight e dall'IPC `deploy:verify`. */
export function verifyDeployLive(dataDir: string) {
  return verifyDeployedInstance(dataDir, verifyIo)
}

/** Directory Data del deploy attivo (condivisa con l'engine deploy via resolveTarget). */
export function activeDeployDataDir(db: Database.Database, store: Store, gamePath: string | null): string | null {
  const profileId = resolveActiveProfileId(db, store)
  let profileName: string | null = null
  try {
    const row = db.prepare('SELECT name FROM profiles WHERE id=?').get(profileId) as
      | { name: string }
      | undefined
    profileName = row?.name ?? null
  } catch {
    profileName = null
  }
  return resolveDeployDataDir({
    deployTarget: store.get('deployTarget') as string | undefined,
    gameDataDir: gamePath ? join(gamePath, 'Data') : null,
    profileName,
    instanceRoot:
      (store.get('instancePath') as string | undefined) || join(app.getPath('userData'), 'instances'),
  })
}

// Assembles the serializable launch environment from local sources (Steam probe,
// DB, settings, filesystem) and runs the pure workflow. COMPANION MODE: read-only;
// the gate decision is enforced HERE in main before any process is spawned.

export function buildLaunchEnv(db: Database.Database, store: Store): LaunchEnv {
  const __t: Record<string, number> = {}
  const __mark = (label: string) => {
    __t[label] = Date.now()
  }
  __mark('start')
  const { steam, skyrim } = detectSteamEnv()
  __mark('steam')

  // SKSE presence + real game-version compatibility (T5).
  const gamePath = skyrim.path ?? (store.get('gamePath') as string | undefined) ?? null
  const skseInfo = detectSkse(gamePath)
  const skse = {
    present: skseInfo.present,
    version: skseInfo.version,
    gameVersionSupported: skseInfo.gameVersionSupported,
  }
  const ssePlugins = gamePath ? join(gamePath, 'Data', 'SKSE', 'Plugins') : null
  // Address Library: accetta ENTRAMBI i naming reali (SE `version-…bin`, AE `versionlib-…bin`).
  // Il vecchio pattern solo-SE marcava "mancante" un'installazione AE corretta e bloccava il
  // gate di avvio. Quando conosciamo la versione del runtime verifichiamo anche che esista il
  // .bin corrispondente (null = non verificabile, mai blocco spurio).
  const addressBins =
    ssePlugins && existsSync(ssePlugins) ? readdirSync(ssePlugins).filter(isAddressLibraryBin) : []
  const addressLibrary = {
    present: addressBins.length > 0,
    correctForVersion: addressLibraryMatchesVersion(addressBins, skyrim.version ?? null),
  }

  // MO2 target + real plugins.txt from the active profile (T3).
  const mo2Path = (store.get('mo2Path') as string | undefined) ?? null
  const mo2 = {
    path: mo2Path,
    valid: !!mo2Path && existsSync(mo2Path) && /modorganizer\.exe$/i.test(mo2Path),
  }
  const mo2Plugins = resolveMo2Plugins(mo2Path)
  const realPlugins = resolveRealPlugins(mo2Plugins.plugins)
  // Flag light REALE dall'header TES4 del file deployato in Data: il conteggio slot per
  // estensione dava "1771 FULL su 254" con ~1500 .esp ESL-flagged (248 slot reali) —
  // il deployer conta dai flag e passava, il preflight bocciava. Header illeggibile o
  // file assente → light undefined (countFullSlots ricade sull'estensione).
  const dataDirForFlags = gamePath ? join(gamePath, 'Data') : null
  const pluginsWithFlags = realPlugins.plugins.map((p) => {
    if (!dataDirForFlags) return p
    try {
      const h = readPluginHeader(join(dataDirForFlags, p.name))
      return h ? { ...p, light: h.isLight } : p
    } catch {
      return p
    }
  })
  __mark('plugins+headers')

  // Mods / modlist completeness from the DB (active profile).
  const profileId = resolveActiveProfileId(db, store)
  const mods = db
    .prepare('SELECT name, is_enabled, is_installed FROM mods WHERE profile_id=?')
    .all(profileId) as { name: string; is_enabled: number; is_installed: number }[]
  const installed = mods.filter((m) => m.is_installed).length
  const enabled = mods.filter((m) => m.is_enabled).length
  __mark('mods-query')

  let missing: string[] = []
  try {
    const required = db.prepare('SELECT name FROM modlist_catalog WHERE required=1').all() as {
      name: string
    }[]
    const installedNames = new Set(mods.filter((m) => m.is_installed).map((m) => m.name.toLowerCase()))
    missing = required.filter((r) => !installedNames.has(r.name.toLowerCase())).map((r) => r.name)
  } catch {
    /* catalog optional */
  }

  // Delta manifest state — a stored release was verified at ingest time.
  const releaseCount = (db.prepare('SELECT COUNT(*) c FROM catalog_release').get() as { c: number }).c
  const manifest = { used: releaseCount > 0, verified: releaseCount > 0, reason: null as string | null }

  // Backups.
  const backupDir = join(app.getPath('userData'), 'backups')
  let backupCount = 0
  try {
    // I backup reali sono .json.gz (+ .sha256 a fianco, escluso): il vecchio filtro
    // .json contava ZERO con la cartella piena → warning "Nessun backup" perenne.
    backupCount = existsSync(backupDir)
      ? readdirSync(backupDir).filter((f) => /\.json(\.gz)?$/i.test(f)).length
      : 0
  } catch {
    /* */
  }
  __mark('missing+manifest+backups')

  // Update guard: stato protezione acf + drift della versione runtime dall'ultimo lancio.
  let updateGuard: LaunchEnv['updateGuard']
  try {
    const g = readGuardStatus(steam.libraries, SKYRIM_SE_APPID, realGuardFs)
    updateGuard = {
      found: g.found,
      protected: g.protected,
      drift: checkVersionDrift(store.get(LAST_GAME_VERSION_KEY) as string | undefined, skyrim.version),
    }
  } catch {
    updateGuard = undefined
  }
  __mark('updateGuard')

  // Integrità del deploy (external changes): manifest vs disco, sola lettura.
  let deployIntegrity: LaunchEnv['deployIntegrity']
  try {
    const dataDir = activeDeployDataDir(db, store, gamePath)
    if (dataDir) {
      const v = verifyDeployLive(dataDir)
      deployIntegrity = {
        checked: v.checked,
        totalFiles: v.totalFiles,
        missingCount: v.missingCount,
        replacedCount: v.replacedCount,
        junctionsMissingCount: v.junctionsMissingCount,
      }
    }
  } catch {
    deployIntegrity = undefined
  }
  __mark('deployIntegrity')

  // Deploy pendente: la selezione/priorità mod CORRENTE nel DB differisce dal fingerprint
  // salvato nell'ultimo manifest? I file su disco possono essere intatti (deployIntegrity ok)
  // ma non riflettere più cosa l'utente ha scelto ORA — un cambio di selezione/ordine senza
  // rifare il Deploy sarebbe altrimenti invisibile finché non si nota in gioco. Sola lettura,
  // mai un blocco: come deployIntegrity (8b), resta un avviso perché un falso positivo
  // (fingerprint non ancora scritto da un manifest storico) non deve impedire un avvio sano.
  let pendingDeployChanges: LaunchEnv['pendingDeployChanges']
  try {
    const dataDir = activeDeployDataDir(db, store, gamePath)
    const manifestPath = dataDir ? join(dataDir, DEPLOY_MANIFEST_FILE) : null
    if (manifestPath && existsSync(manifestPath)) {
      const manifest = parseDeployManifest(readFileSync(manifestPath, 'utf8'), dataDir!)
      if (manifest?.modsFingerprint) {
        const currentRows = db
          .prepare(
            "SELECT name, priority FROM mods WHERE is_enabled=1 AND is_installed=1 AND install_path IS NOT NULL AND profile_id=? ORDER BY priority ASC, name ASC",
          )
          .all(profileId) as { name: string; priority: number }[]
        pendingDeployChanges = computeModsFingerprint(currentRows) !== manifest.modsFingerprint
      }
    }
  } catch {
    pendingDeployChanges = undefined
  }
  __mark('pendingDeployChanges')

  // Save Doctor: ultimo salvataggio vs load order attivo (fail-soft: mai warning spuri).
  let saveDoctor: LaunchEnv['saveDoctor']
  try {
    const sd = runSaveDoctorLive(gamePath, activeSavesDir(db, store))
    saveDoctor = {
      checked: sd.checked,
      saveName: sd.saveName,
      missingCount: sd.missingCount,
      missingPlugins: sd.missingPlugins,
    }
  } catch {
    saveDoctor = undefined
  }
  __mark('saveDoctor')

  // Pagefile Windows (gap Nolvus): fail-soft, mai un blocco — solo un avviso se fisso e sotto
  // 20GB. Probe fallito (PowerShell assente/timeout) → checked:false, nessun avviso spurio.
  // Cache TTL 24h (vedi PAGEFILE_CACHE_KEY): risparmia lo spawn di powershell.exe su ogni
  // lancio, il costo fisso più alto di questa funzione.
  let pagefile: LaunchEnv['pagefile']
  try {
    const cached = store.get(PAGEFILE_CACHE_KEY) as PagefileCacheEntry | undefined
    const fresh = cached && Date.now() - cached.checkedAt < PAGEFILE_CACHE_TTL_MS
    const info = fresh ? cached!.info : queryPagefileInfo()
    if (!fresh) store.set(PAGEFILE_CACHE_KEY, { checkedAt: Date.now(), info } as PagefileCacheEntry)
    pagefile = evaluatePagefile(info)
  } catch {
    pagefile = undefined
  }
  __mark('pagefile')

  const __order = ['start', 'steam', 'plugins+headers', 'mods-query', 'missing+manifest+backups', 'updateGuard', 'deployIntegrity', 'pendingDeployChanges', 'saveDoctor', 'pagefile']
  const __parts: string[] = []
  for (let i = 1; i < __order.length; i++) {
    if (__t[__order[i]] != null && __t[__order[i - 1]] != null)
      __parts.push(`${__order[i]}=${__t[__order[i]] - __t[__order[i - 1]]}ms`)
  }
  // eslint-disable-next-line no-console
  console.log(`[PERF buildLaunchEnv] total=${Date.now() - __t.start}ms | ${__parts.join(' ')}`)

  return {
    steam,
    skyrim,
    skse,
    addressLibrary,
    mo2,
    mods: { total: mods.length, enabled, installed },
    // Load order REALE (plugins.txt di sistema, quella che il gioco legge), non MO2.
    plugins: pluginsWithFlags,
    pluginsSource: realPlugins.source,
    modlist: { complete: missing.length === 0, missing },
    manifest,
    backups: { count: backupCount, lastValid: backupCount > 0 },
    updateGuard,
    deployIntegrity,
    pendingDeployChanges,
    saveDoctor,
    pagefile,
    // DIRETTIVA: avvio esclusivo via SKSE interno del launcher — MO2 mai target, anche se
    // configurato (i campi mo2.* restano informativi per la pipeline di verifica).
    launchTarget: skse.present ? 'skse' : null,
  }
}

export function runPreflight(db: Database.Database, store: Store): LaunchReport {
  return runLaunchWorkflow(buildLaunchEnv(db, store))
}

export interface LaunchResult {
  launched: boolean
  report: LaunchReport
  error?: string
}

export async function executeLaunch(db: Database.Database, store: Store): Promise<LaunchResult> {
  const env = buildLaunchEnv(db, store)
  const report = runLaunchWorkflow(env)
  if (!report.canLaunch) return { launched: false, report } // companion mode: blocked

  // Solo SKSE diretto: il launcher È il mod manager (deploy hardlink + plugins.txt di
  // sistema già scritti), MO2 non entra mai nel percorso di avvio.
  const target = env.skyrim.path
    ? { exe: join(env.skyrim.path, 'skse64_loader.exe'), cwd: env.skyrim.path }
    : null
  if (!target) return { launched: false, report, error: 'Nessun eseguibile di avvio risolvibile' }

  return new Promise<LaunchResult>((resolve) => {
    execFile(target.exe, [], { cwd: target.cwd }, (err) => {
      if (err) resolve({ launched: false, report, error: err.message })
    })
    // execFile callback only fires on exit/error; the launch itself succeeds
    // immediately, so report success after spawning.
    setTimeout(() => {
      recordGameVersion(store, env.skyrim.version)
      resolve({ launched: true, report })
    }, 300)
  })
}

/** Registra la versione runtime vista a un lancio riuscito: baseline del drift detection.
 *  Chiamare SOLO dopo un avvio andato a buon fine — mai in preflight (azzererebbe il confronto). */
export function recordGameVersion(store: Store, version: string | null | undefined): void {
  try {
    if (version) store.set(LAST_GAME_VERSION_KEY, version)
  } catch {
    /* best-effort */
  }
}
