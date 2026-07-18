// Analizzatore di crash log Skyrim SE (formato Crash Logger SSE/AE/VR e Trainwreck — stesso
// layout, entrambi discendenti del formato originale di fudgyduff). PURO: parse su stringa,
// nessun fs qui (il wrapper IPC legge il file). Ispirato a Phostwood's Crash Log Analyzer (tool
// web pubblico): qui NON è un database vivo di pattern noti, è un'euristica strutturale piccola
// e onesta — identifica il modulo probabile colpevole dalla call stack e mostra sempre le
// sezioni strutturate, mai solo un dump grezzo.

import { matchCrashPatterns, type CrashPatternMatch } from './crashPatterns'

export interface CallStackFrame {
  index: number
  address: string
  module: string
  offset: string
  instruction: string | null
}

export interface CrashLogReport {
  gameVersion: string | null
  crashLoggerVersion: string | null
  exceptionType: string | null
  exceptionModule: string | null
  callStack: CallStackFrame[]
  ssePlugins: { name: string; version: string | null }[]
  plugins: string[] // nomi .esp/.esm/.esl nell'ordine del load order (indice esadecimale scartato)
  /** true se il parser ha riconosciuto ALMENO l'header — un file totalmente estraneo dà false. */
  recognized: boolean
}

// Moduli di sistema/engine: MAI il "colpevole" nell'euristica, sono sempre in cima alla call
// stack di QUALSIASI crash (kernel, runtime C, l'exe stesso).
const ENGINE_MODULES = new Set([
  'skyrimse.exe',
  'ntdll.dll',
  'kernel32.dll',
  'kernelbase.dll',
  'ucrtbase.dll',
  'msvcrt.dll',
  'win32u.dll',
  'user32.dll',
  'gdi32.dll',
])

/** Un modulo NON di sistema nella call stack — il candidato più probabile per "chi ha causato
 * il crash". null se la call stack è vuota o contiene solo moduli di sistema (crash nel motore
 * stesso: nessun mod DLL da incolpare, non necessariamente un bug del gioco vanilla). */
export function findProbableCulprit(callStack: CallStackFrame[]): CallStackFrame | null {
  for (const f of callStack) {
    if (!ENGINE_MODULES.has(f.module.toLowerCase())) return f
  }
  return null
}

const HEX_LINE = /^\[\s*([0-9A-Fa-f]+)\s*\]\s+0x([0-9A-Fa-f]+)\s+(\S+)\+([0-9A-Fa-f]+)(?:\s*->\s*\S+)?(?:\t(.*))?$/

function parseCallStackLine(line: string): CallStackFrame | null {
  const m = line.trim().match(HEX_LINE)
  if (!m) return null
  return {
    index: Number.parseInt(m[1], 16),
    address: `0x${m[2]}`,
    module: m[3],
    offset: m[4],
    instruction: m[5]?.trim() || null,
  }
}

/** Parse difensivo dell'intero crash log. Testo non riconoscibile → report con recognized:false
 * (sezioni vuote), mai un throw: il chiamante mostra comunque il testo grezzo come fallback. */
export function parseCrashLog(text: string): CrashLogReport {
  const lines = text.split(/\r?\n/)

  const headerMatch = text.match(/^(Skyrim(?: S?SE| VR)?(?:\.exe)? v?[\d.]+)/im)
  const loggerMatch = text.match(/(CrashLogger\S*\s+v?\S+|Trainwreck\s+v?\S+)/i)
  const exceptionMatch = text.match(
    /Unhandled (?:native )?exception\s+"?([A-Z_]+)"?\s+(?:occurred )?at\s+0x[0-9A-Fa-f]+\s+(\S+)\+/i,
  )

  const callStack: CallStackFrame[] = []
  let inCallStack = false
  for (const raw of lines) {
    if (/^PROBABLE CALL STACK:/i.test(raw.trim())) {
      inCallStack = true
      continue
    }
    if (inCallStack) {
      if (raw.trim() === '' || /^[A-Z][A-Z ]*:$/.test(raw.trim())) {
        inCallStack = false
        continue
      }
      const frame = parseCallStackLine(raw)
      if (frame) callStack.push(frame)
    }
  }

  const ssePlugins: { name: string; version: string | null }[] = []
  let inSse = false
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (/^(SKSE|XSE) PLUGINS:/i.test(trimmed)) {
      inSse = true
      continue
    }
    if (inSse) {
      if (trimmed === '' || /^[A-Z][A-Z ]*:$/.test(trimmed)) {
        inSse = false
        continue
      }
      const m = trimmed.match(/^(\S+\.dll)(?:\s+v?([\d.]+))?$/i)
      if (m) ssePlugins.push({ name: m[1], version: m[2] ?? null })
    }
  }

  const plugins: string[] = []
  let inPlugins = false
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (/^PLUGINS:$/i.test(trimmed)) {
      inPlugins = true
      continue
    }
    if (inPlugins) {
      if (trimmed === '' || /^[A-Z][A-Z ]*:$/.test(trimmed)) {
        inPlugins = false
        continue
      }
      const m = trimmed.match(/^\[\s*([0-9A-Fa-f]+)\s*\]\s+(.+\.(?:esm|esp|esl))$/i)
      if (m) plugins.push(m[2])
    }
  }

  const recognized = !!(headerMatch || loggerMatch || exceptionMatch || callStack.length)
  return {
    gameVersion: headerMatch?.[1]?.trim() ?? null,
    crashLoggerVersion: loggerMatch?.[0]?.trim() ?? null,
    exceptionType: exceptionMatch?.[1] ?? null,
    exceptionModule: exceptionMatch?.[2] ?? null,
    callStack,
    ssePlugins,
    plugins,
    recognized,
  }
}

export interface CrashAnalysis {
  culprit: CallStackFrame | null
  suggestions: string[]
  /** Firme note riconosciute nel log (DB derivato da Phostwood, vedi crashPatterns.ts). */
  knownPatterns?: CrashPatternMatch[]
}

/**
 * Euristica strutturale (modulo colpevole + suggerimenti strutturali) POTENZIATA dal
 * database di firme note derivato da Phostwood's Crash Log Analyzer (crashPatterns.ts):
 * passando il testo grezzo, le categorie riconosciute (driver GPU, behaviour, fisiche,
 * memoria, …) arrivano con consigli ricollegati alle azioni del launcher. Il report
 * strutturato completo va sempre mostrato accanto: nessuna pretesa di coprire ogni caso.
 */
export function analyzeCrashLog(report: CrashLogReport, rawText?: string): CrashAnalysis {
  const suggestions: string[] = []
  const culprit = findProbableCulprit(report.callStack)

  if (culprit) {
    suggestions.push(
      `Il modulo più probabilmente coinvolto è "${culprit.module}" (frame [${culprit.index}] nella call stack). Verifica la mod che lo fornisce: versione aggiornata, compatibilità con la versione di gioco, o una nota conosciuta nella pagina Nexus.`,
    )
  } else if (report.callStack.length) {
    suggestions.push(
      'La call stack coinvolge solo moduli di sistema/motore: non è identificabile una mod specifica da qui. Il crash potrebbe derivare da corruzione dei dati di salvataggio, un plugin con record danneggiati, o un problema hardware/driver.',
    )
  }

  if (report.exceptionType === 'EXCEPTION_STACK_OVERFLOW') {
    suggestions.push(
      'Stack overflow: tipico di script Papyrus con ricorsione o cicli non terminati. Controlla i log Papyrus per stack dump ripetuti dello stesso script.',
    )
  }

  if (report.recognized && report.ssePlugins.length === 0) {
    suggestions.push(
      'Nessun plugin SKSE risulta caricato nel log: se il crash avviene subito all\'avvio, verifica che SKSE sia installato correttamente e che i suoi plugin (incluso Address Library) siano compatibili con la versione di gioco.',
    )
  }

  const knownPatterns = rawText ? matchCrashPatterns(rawText) : undefined
  return { culprit, suggestions, knownPatterns: knownPatterns?.length ? knownPatterns : undefined }
}
