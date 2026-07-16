import { join } from 'path'
import { parseVdf, type VdfNode } from './vdf'

// Protezione aggiornamenti Steam (stile community consolidato): Steam aggiorna Skyrim
// in autonomia e rompe SKSE + tutti i plugin nativi finché non escono le build nuove.
// Il metodo standard (guida Steam/Nexus) è rendere READ-ONLY l'appmanifest_489830.acf:
// Steam non riesce più a scrivere lo stato dell'app e quindi non aggiorna. Compatibile
// SOLO con l'avvio via skse64_loader.exe — che è l'unico percorso di questo launcher.
//
// PURO: ogni IO è iniettato (FsOps) così status/toggle sono unit-testabili senza disco.
// La rimozione della protezione ripristina il file scrivibile: reversibile in un click.

export interface UpdateGuardFsOps {
  exists: (p: string) => boolean
  readFile: (p: string) => string
  /** true se il file ha l'attributo read-only (Windows: bit di scrittura assente). */
  isReadOnly: (p: string) => boolean
  setReadOnly: (p: string, readOnly: boolean) => void
}

export interface UpdateGuardStatus {
  /** appmanifest trovato in una libreria Steam. */
  found: boolean
  manifestPath: string | null
  /** true = file read-only, Steam non può aggiornare. */
  protected: boolean
  /** Valore AutoUpdateBehavior dell'acf (0=sempre, 1=solo all'avvio, 2=alta priorità); null se illeggibile. */
  autoUpdateBehavior: number | null
  /** buildid corrente dell'acf (cambia a ogni update Steam); null se illeggibile. */
  buildId: string | null
}

/** Percorso dell'appmanifest dell'app nelle librerie Steam note (prima esistente vince). */
export function findAppManifest(
  libraries: string[],
  appId: number,
  exists: (p: string) => boolean,
): string | null {
  for (const lib of libraries) {
    const p = join(lib, 'steamapps', `appmanifest_${appId}.acf`)
    if (exists(p)) return p
  }
  return null
}

function acfString(root: VdfNode, key: string): string | null {
  const state = root['AppState']
  if (!state || typeof state === 'string') return null
  const v = state[key]
  return typeof v === 'string' ? v : null
}

export function readGuardStatus(
  libraries: string[],
  appId: number,
  fs: UpdateGuardFsOps,
): UpdateGuardStatus {
  const manifestPath = findAppManifest(libraries, appId, fs.exists)
  if (!manifestPath) {
    return { found: false, manifestPath: null, protected: false, autoUpdateBehavior: null, buildId: null }
  }
  let autoUpdateBehavior: number | null = null
  let buildId: string | null = null
  try {
    const root = parseVdf(fs.readFile(manifestPath))
    const aub = acfString(root, 'AutoUpdateBehavior')
    autoUpdateBehavior = aub !== null && /^\d+$/.test(aub) ? parseInt(aub, 10) : null
    buildId = acfString(root, 'buildid')
  } catch {
    /* acf illeggibile → campi null, lo stato protected resta valido */
  }
  let isProtected = false
  try {
    isProtected = fs.isReadOnly(manifestPath)
  } catch {
    /* probe fallita → riportato come non protetto */
  }
  return { found: true, manifestPath, protected: isProtected, autoUpdateBehavior, buildId }
}

export interface SetGuardResult {
  success: boolean
  protected: boolean
  error?: string
}

/** Attiva/disattiva la protezione (attributo read-only sull'acf). Mai throw. */
export function setGuardProtection(
  manifestPath: string | null,
  enabled: boolean,
  fs: UpdateGuardFsOps,
): SetGuardResult {
  if (!manifestPath || !fs.exists(manifestPath)) {
    return { success: false, protected: false, error: 'appmanifest non trovato nelle librerie Steam' }
  }
  try {
    fs.setReadOnly(manifestPath, enabled)
    const now = fs.isReadOnly(manifestPath)
    if (now !== enabled) {
      return { success: false, protected: now, error: 'attributo read-only non applicato' }
    }
    return { success: true, protected: now }
  } catch (e) {
    return { success: false, protected: false, error: (e as Error).message }
  }
}

export interface VersionDrift {
  /** true = la versione del runtime è CAMBIATA dall'ultima registrata (update Steam avvenuto). */
  changed: boolean
  from: string | null
  to: string | null
}

/**
 * Confronto versione registrata ↔ corrente. null quando non decidibile (mai registrata
 * o versione corrente ignota): nessun warning spurio al primo avvio.
 */
export function checkVersionDrift(
  lastKnown: string | null | undefined,
  current: string | null | undefined,
): VersionDrift | null {
  if (!lastKnown || !current) return null
  return { changed: lastKnown !== current, from: lastKnown, to: current }
}
