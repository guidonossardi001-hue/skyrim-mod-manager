import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import type Store from 'electron-store'
import { detectSteamEnv, detectSkse } from '../steam/detect'
import { isAddressLibraryBin, addressLibraryMatchesVersion } from './addressLibrary'
import { resolveMo2Plugins } from '../steam/mo2'
import { runLaunchWorkflow, type LaunchEnv, type LaunchReport } from '../../src/lib/launchWorkflow'
import { resolveActiveProfileId } from '../util/activeProfile'

// Assembles the serializable launch environment from local sources (Steam probe,
// DB, settings, filesystem) and runs the pure workflow. COMPANION MODE: read-only;
// the gate decision is enforced HERE in main before any process is spawned.

export function buildLaunchEnv(db: Database.Database, store: Store): LaunchEnv {
  const { steam, skyrim } = detectSteamEnv()

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

  // Mods / modlist completeness from the DB (active profile).
  const profileId = resolveActiveProfileId(db, store)
  const mods = db
    .prepare('SELECT name, is_enabled, is_installed FROM mods WHERE profile_id=?')
    .all(profileId) as { name: string; is_enabled: number; is_installed: number }[]
  const installed = mods.filter((m) => m.is_installed).length
  const enabled = mods.filter((m) => m.is_enabled).length

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
    backupCount = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => f.endsWith('.json')).length : 0
  } catch {
    /* */
  }

  return {
    steam,
    skyrim,
    skse,
    addressLibrary,
    mo2,
    mods: { total: mods.length, enabled, installed },
    plugins: mo2Plugins.plugins, // parsed from <MO2>/profiles/<active>/plugins.txt (T3)
    modlist: { complete: missing.length === 0, missing },
    manifest,
    backups: { count: backupCount, lastValid: backupCount > 0 },
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
    setTimeout(() => resolve({ launched: true, report }), 300)
  })
}
