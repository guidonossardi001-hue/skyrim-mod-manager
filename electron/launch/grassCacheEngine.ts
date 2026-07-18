// Grass cache "autopilota" — parte IO/supervisione (T19). Ricalca ESATTAMENTE il pattern
// dell'unico automatismo reale noto in community, Al12rs/modorganizer-GrassPrecacher.py: crea
// il marker file, lancia il gioco, attende che il processo termini (crash o normale), e se il
// marker esiste ANCORA rilancia automaticamente — fino a un tetto di tentativi/tempo. Non genera
// mai la cache "senza il gioco": la generazione resta interamente dentro il processo di
// NGIO/GrassControl mentre gira Skyrim vero (vedi grassCache.ts per i fatti verificati).
//
// `supervisePrecache` è puro sulle dipendenze iniettate (nessun `child_process`/`fs` diretto),
// stesso stile DI di activeLaunch.ts — interamente testabile senza spawnare/aspettare nulla di
// reale. Le funzioni marker/scan sotto sono i thin wrapper IO, mai chiamate dal loop puro.

import { readdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { PRECACHE_MARKER_FILENAME } from './grassCache'

export function markerFilePath(gameRootPath: string): string {
  return join(gameRootPath, PRECACHE_MARKER_FILENAME)
}

export function markerFileExists(gameRootPath: string): boolean {
  return existsSync(markerFilePath(gameRootPath))
}

/** Crea il marker vuoto. Idempotente: sovrascrive se già presente. */
export function writeMarkerFile(gameRootPath: string): void {
  writeFileSync(markerFilePath(gameRootPath), '')
}

/** Rimuove il marker se presente. Mai throw (può essere già stato rimosso da NGIO stesso). */
export function removeMarkerFileIfExists(gameRootPath: string): void {
  try {
    unlinkSync(markerFilePath(gameRootPath))
  } catch {
    /* già assente o non rimovibile: non è un errore per il chiamante */
  }
}

/** Elenca i .cgid presenti in <gamePath>/Data/Grass. Cartella assente/illeggibile → []. */
export function listGrassCacheFiles(gamePath: string): string[] {
  try {
    return readdirSync(join(gamePath, 'Data', 'Grass')).filter((f) => /\.cgid$/i.test(f))
  } catch {
    return []
  }
}

export interface PrecacheSuperviseDeps {
  launch: () => { success: boolean; pid?: number; error?: string }
  isGameRunning: () => boolean
  markerExists: () => boolean
  sleep: (ms: number) => Promise<void>
  onProgress?: (ev: { attempt: number; status: string }) => void
  maxAttempts?: number // default 15 — un rilancio in più oltre questo tetto non aiuta, serve intervento umano
  maxTotalMs?: number // default 3h (stesso ordine di grandezza della durata attesa 25min-2,5h)
  pollIntervalMs?: number // default 5000
  startupGraceMs?: number // default 15000 — sotto questa soglia un'uscita è quasi certamente un crash all'avvio
}

export interface PrecacheSuperviseResult {
  /** true = il marker è stato rimosso (NGIO ha segnalato la fine del lavoro). */
  completed: boolean
  attempts: number
  reason: string
}

/**
 * Loop di supervisione: lancia il gioco, attende che il processo termini, ricontrolla il
 * marker. Nessuna generazione di contenuto avviene qui — solo lancio/attesa/rilancio, esattamente
 * ciò che fa un plugin MO2 dedicato con un gioco vero. Mai un ciclo infinito: tetto duro su
 * tentativi E su tempo totale.
 */
export async function supervisePrecache(deps: PrecacheSuperviseDeps): Promise<PrecacheSuperviseResult> {
  const maxAttempts = deps.maxAttempts ?? 15
  const maxTotalMs = deps.maxTotalMs ?? 3 * 60 * 60 * 1000
  const pollIntervalMs = deps.pollIntervalMs ?? 5000
  const startupGraceMs = deps.startupGraceMs ?? 15000

  const startAll = Date.now()
  let attempts = 0

  while (deps.markerExists() && attempts < maxAttempts && Date.now() - startAll < maxTotalMs) {
    attempts++
    const launchRes = deps.launch()
    if (!launchRes.success) {
      deps.onProgress?.({ attempt: attempts, status: `avvio fallito: ${launchRes.error ?? 'errore sconosciuto'}` })
      return { completed: false, attempts, reason: `Lancio fallito: ${launchRes.error ?? 'errore sconosciuto'}` }
    }
    deps.onProgress?.({ attempt: attempts, status: 'gioco avviato, in attesa che il precache termini o crashi' })

    const launchedAt = Date.now()
    while (deps.isGameRunning() && Date.now() - startAll < maxTotalMs) {
      await deps.sleep(pollIntervalMs)
    }
    const ranMs = Date.now() - launchedAt
    if (ranMs < startupGraceMs) {
      deps.onProgress?.({ attempt: attempts, status: `terminato dopo solo ${ranMs}ms — probabile crash all'avvio, interrotto` })
      return {
        completed: false,
        attempts,
        reason: "Il gioco è terminato quasi subito dopo il lancio (crash all'avvio): controlla i log crash prima di riprovare",
      }
    }
    deps.onProgress?.({ attempt: attempts, status: deps.markerExists() ? 'processo terminato, marker ancora presente: rilancio' : 'processo terminato, marker rimosso' })
  }

  if (!deps.markerExists()) return { completed: true, attempts, reason: 'Marker rimosso: precache considerato completato' }
  return {
    completed: false,
    attempts,
    reason:
      attempts >= maxAttempts
        ? `Raggiunto il limite di ${maxAttempts} rilanci senza che il marker venisse rimosso`
        : 'Raggiunto il tempo massimo di supervisione',
  }
}
