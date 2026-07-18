// Validazione header ESP (T15) — controllo del range FormID per plugin ESL/light e report
// informativo del "form version" per-record (43/44). PURO sulla Buffer, riusa lo stesso walk
// record-per-record di eslify.ts (scanPluginRecords), che già instrada masterCount/formVersion/
// object-index per i record propri.
//
// Fatti verificati (ricerca GitHub/web dedicata, 2026-07-18), fonti: UESP Skyrim_Mod:Mod_File_Format,
// xEdit changelog ufficiale 4.1.5b (sezione "Extended FormID Range in Skyrim Special Edition"),
// CommonLibSSE-NG (RE::FORM, RE::TESFile):
//
//   • formVersion (u16 a offset 0x14 dell'header record): 43=Skyrim LE (Oldrim), 44=Skyrim SE/AE.
//     NON è una distinzione "pre/post Anniversary Edition" (form44 è lo standard SE dal 2016).
//     Il motore legge quasi ogni record identicamente sotto 43 o 44: non è un errore bloccante,
//     solo un'informazione. L'unica anomalia strutturale nota (bug WEAP/CRDT in Creation Kit)
//     non è verificabile da un semplice scan di formVersion, quindi non è coperta qui.
//
//   • Range object-index (12 bit bassi del FormID) per i record NUOVI di un plugin light (flag
//     0x200 nel TES4.flags):
//       - HEDR.version < 1.71: range valido = [0x800, 0xFFF] (2048 slot). Il range [0x001,0x7FF]
//         era storicamente riservato dal motore — usarlo può corrompere il file/causare crash.
//       - HEDR.version >= 1.71 (patch Bethesda "Creations Update" 1.6.1130, dic 2023): range
//         esteso a [0x001, 0xFFF] (4096 slot totali).
//     0x000 non è mai un object-index valido (FormID nullo).

import { readFileSync } from 'fs'
import { readPluginHeader, type PluginHeader } from './espParser'
import { scanPluginRecords, type PluginScanInfo } from './eslify'

export const HEDR_EXTENDED_RANGE_VERSION = 1.71
const LEGACY_ESL_RANGE: [number, number] = [0x800, 0xfff]
const EXTENDED_ESL_RANGE: [number, number] = [0x001, 0xfff]

export type EspValidationVerdict = 'ok' | 'warning' | 'error' | 'unknown'

export interface EspValidationReport {
  name: string
  verdict: EspValidationVerdict
  reason: string
  isLight: boolean
  hedrVersion: number | null
  /** true se l'header abilita il range object-index esteso 0x001-0x7FF (richiede HEDR.version >= 1.71). */
  extendedRangeEnabled: boolean
  /** Object-index dei record propri fuori dal range valido per l'HEDR.version corrente. */
  outOfRangeObjectIndices: number[]
  /** Conteggio per valore di formVersion (43/44/altro), solo informativo — mai bloccante. */
  formVersionCounts: Record<number, number>
}

function isInRange(objectIndex: number, ranges: [number, number][]): boolean {
  return ranges.some(([lo, hi]) => objectIndex >= lo && objectIndex <= hi)
}

/** Valida i vincoli ESL/light su un plugin già parsato (header + scan record). */
export function validateEspBuffers(name: string, header: PluginHeader | null, scan: PluginScanInfo): EspValidationReport {
  const base = {
    name,
    isLight: scan.isLight,
    hedrVersion: header?.version ?? null,
    formVersionCounts: scan.formVersionCounts,
  }
  if (!scan.parsed) {
    return { ...base, verdict: 'unknown', reason: 'parse record incompleto/anomalo', extendedRangeEnabled: false, outOfRangeObjectIndices: [] }
  }
  if (!scan.isLight) {
    return { ...base, verdict: 'ok', reason: 'plugin full: nessun vincolo di range FormID', extendedRangeEnabled: false, outOfRangeObjectIndices: [] }
  }

  const extendedRangeEnabled = (header?.version ?? 0) >= HEDR_EXTENDED_RANGE_VERSION
  const validRanges = extendedRangeEnabled ? [EXTENDED_ESL_RANGE] : [LEGACY_ESL_RANGE]
  const outOfRangeObjectIndices = [...new Set(scan.ownRecordObjectIndices.filter((oi) => !isInRange(oi, validRanges)))]

  if (outOfRangeObjectIndices.length > 0) {
    const sample = outOfRangeObjectIndices.slice(0, 5).map((oi) => `0x${oi.toString(16).toUpperCase()}`).join(', ')
    return {
      ...base,
      verdict: 'error',
      reason: extendedRangeEnabled
        ? `${outOfRangeObjectIndices.length} record con object-index fuori dal range esteso 0x001-0xFFF (es. ${sample})`
        : `${outOfRangeObjectIndices.length} record con object-index fuori dal range ESL valido 0x800-0xFFF (es. ${sample}) — HEDR.version=${header?.version ?? '?'} non abilita il range esteso 0x001-0x7FF (richiede >= ${HEDR_EXTENDED_RANGE_VERSION})`,
      extendedRangeEnabled,
      outOfRangeObjectIndices,
    }
  }
  return {
    ...base,
    verdict: 'ok',
    reason: 'range object-index dei record propri valido',
    extendedRangeEnabled,
    outOfRangeObjectIndices: [],
  }
}

/** Legge e valida un plugin dal filesystem. Mai throw: errori I/O → verdict 'unknown'. */
export function readAndValidateEsp(filePath: string, name: string): EspValidationReport {
  try {
    const header = readPluginHeader(filePath)
    const buf = readFileSync(filePath)
    const scan = scanPluginRecords(buf)
    return validateEspBuffers(name, header, scan)
  } catch (e) {
    return {
      name,
      verdict: 'unknown',
      reason: `lettura fallita: ${(e as Error).message}`,
      isLight: false,
      hedrVersion: null,
      extendedRangeEnabled: false,
      outOfRangeObjectIndices: [],
      formVersionCounts: {},
    }
  }
}
