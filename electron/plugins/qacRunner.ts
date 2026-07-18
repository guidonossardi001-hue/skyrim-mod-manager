// Quick Auto Clean headless via xEdit/SSEEdit (T20) — parte pura: costruzione argomenti CLI e
// classificazione dell'esito dal log. Nessun exit-code contrattuale documentato ufficialmente
// (verificato: né la wiki STEP né il source Delphi xeInit.pas ne specificano uno) — il segnale
// autoritativo è il file di log scritto ALL'USCITA del processo, stesso approccio del tool
// community di riferimento PACT (github.com/GuidanceOfGrace/XEdit-PACT).
//
// Fonti verificate (ricerca GitHub/web dedicata, 2026-07-18):
//   - Flag CLI: github.com/TES5Edit/TES5Edit/blob/dev-4.1.6/whatsnew.md (-quickautoclean/-qac
//     da 4.0.0, alias corto da 4.0.3; -autoexit da 4.0.2; -autoload da 4.0.0)
//   - Nome plugin come argomento posizionale nudo: whatsnew.md 4.0.2, esempio ufficiale
//     "SSEEdit.exe -quickautoclean -autoload update.esm"
//   - Pattern regex del log + convenzione nomi file: github.com/GuidanceOfGrace/XEdit-PACT
//   - Bug storico "QAC permette di selezionare il master di gioco": whatsnew.md 4.0.3

import { BASE_MASTERS } from '../deploy/plan'

export interface QacArgsOptions {
  /** Flag gioco per xEdit (es. "SSE"), case-insensitive — determina il comportamento indipendentemente dal nome dell'exe. */
  gameFlag: string
  dataPath: string
  /** plugins.txt temporaneo/minimale (master + il plugin target attivi) — mai quello reale del profilo. */
  pluginsTxtPath: string
  pluginName: string
}

/** Argomenti CLI (esclude il path dell'exe) per un run headless di Quick Auto Clean. */
export function buildQacArgs(opts: QacArgsOptions): string[] {
  return [
    `-${opts.gameFlag}`,
    '-autoload',
    '-autoexit',
    '-QAC',
    `-D:${opts.dataPath}`,
    `-P:${opts.pluginsTxtPath}`,
    opts.pluginName,
  ]
}

/** true = il plugin è un master ufficiale del gioco base — MAI un target di pulizia (bug storico xEdit <4.0.3). */
export function isProtectedMaster(pluginName: string): boolean {
  const lower = pluginName.toLowerCase()
  return BASE_MASTERS.some((m) => m.toLowerCase() === lower)
}

/** Nome file di log/exception convenzionale per un dato prefisso gioco (es. "SSE" → "SSEEdit_log.txt"). */
export function qacLogFileNames(gameFlag: string): { log: string; exception: string } {
  const prefix = `${gameFlag}Edit`
  return { log: `${prefix}_log.txt`, exception: `${prefix}Exception.log` }
}

export interface QacLogSummary {
  undeleted: string[]
  removed: string[]
  skippedNavmeshes: string[]
  nothingToClean: boolean
}

/** Estrae le righe Undeleting:/Removing:/Skipping: dal log xEdit (pattern verificato da PACT). */
export function parseQacLog(logText: string): QacLogSummary {
  const grab = (label: string) =>
    [...logText.matchAll(new RegExp(`^${label}:\\s*(.*)$`, 'gim'))].map((m) => m[1].trim())
  const undeleted = grab('Undeleting')
  const removed = grab('Removing')
  const skippedNavmeshes = grab('Skipping')
  return { undeleted, removed, skippedNavmeshes, nothingToClean: undeleted.length + removed.length + skippedNavmeshes.length === 0 }
}

export type QacVerdict = 'cleaned' | 'nothing-to-clean' | 'crashed' | 'timeout' | 'launch-failed' | 'blocked'

export interface QacResult {
  verdict: QacVerdict
  summary: string
  log: QacLogSummary | null
}

/** Combina i segnali osservati (log, exception log, timeout/kill) in un verdetto onesto. */
export function classifyQacRun(opts: { logText: string | null; exceptionLogExists: boolean; timedOut: boolean }): QacResult {
  if (opts.timedOut) {
    return { verdict: 'timeout', summary: 'Processo terminato per timeout (nessun segnale di completamento nel tempo massimo)', log: null }
  }
  if (opts.exceptionLogExists) {
    return { verdict: 'crashed', summary: 'xEdit ha scritto un file di eccezione: il run è terminato con un errore', log: null }
  }
  if (opts.logText === null) {
    return { verdict: 'crashed', summary: 'Nessun file di log prodotto: xEdit potrebbe essere crashato prima di scrivere il log', log: null }
  }
  const log = parseQacLog(opts.logText)
  if (log.nothingToClean) return { verdict: 'nothing-to-clean', summary: 'Nessuna riga Undeleting/Removing/Skipping nel log: plugin già pulito', log }
  const parts: string[] = []
  if (log.removed.length) parts.push(`${log.removed.length} record ITM rimossi`)
  if (log.undeleted.length) parts.push(`${log.undeleted.length} riferimenti UDR ripristinati`)
  if (log.skippedNavmeshes.length) parts.push(`${log.skippedNavmeshes.length} navmesh cancellate rilevate`)
  return { verdict: 'cleaned', summary: parts.join(', '), log }
}
