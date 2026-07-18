// Preflight DLL SKSE — legge il PE/COFF di un plugin SKSE64 (Data/SKSE/Plugins/*.dll) e ne
// estrae la struct dati esportata "SKSEPlugin_Version" (SKSE::PluginVersionData / la vecchia
// SKSEPluginVersionData di skse64: STESSO layout binario, offset identici — confermato dagli
// static_assert nel sorgente CommonLibSSE-NG). Replica la logica DICHIARATIVA che SKSE stesso
// usa dall'Anniversary Update in poi per decidere se caricare un plugin (SKSE non esegue più
// codice del plugin per giudicare compatibilità: legge solo questi dati statici), così il
// preflight può segnalare un plugin problematico PRIMA del lancio, senza mai eseguire il gioco.
//
// PURO sulla Buffer, nessuna libreria PE — tutta la catena (DOS header → PE header → Optional
// Header/DataDirectory → Section Table → Export Directory → risoluzione per nome) è quella
// documentata da Microsoft (learn.microsoft.com/windows/win32/debug/pe-format).
//
// Fonti verificate (ricerca GitHub/web dedicata, 2026-07-18):
//   - PE/COFF ufficiale: learn.microsoft.com/en-us/windows/win32/debug/pe-format
//   - Struct storica: github.com/ianpatt/skse64/blob/master/skse64/PluginAPI.h
//   - Struct NG + static_assert sizeof==0x350: github.com/CharmedBaryon/CommonLibSSE-NG
//     (include/SKSE/Interfaces.h, include/REL/Version.h)
//   - Algoritmo export-by-name: ferreirasc.github.io/PE-Export-Address-Table/

import { readFileSync } from 'fs'

const MACHINE_AMD64 = 0x8664
const OPTIONAL_MAGIC_PE32PLUS = 0x20b
const OPTIONAL_MAGIC_PE32 = 0x10b
const PLUGIN_VERSION_DATA_SIZE = 0x350 // 848 byte, confermato da static_assert CommonLibSSE-NG

interface Section {
  virtualAddress: number
  virtualSize: number
  sizeOfRawData: number
  pointerToRawData: number
}

interface PeInfo {
  machine: number
  sections: Section[]
  exportDirRva: number
  exportDirSize: number
}

/** Parse minimale DOS→PE→Optional Header→Section Table. null = non un PE valido/atteso. */
function parsePe(buf: Buffer): PeInfo | null {
  if (buf.length < 0x40 || buf.toString('ascii', 0, 2) !== 'MZ') return null
  const peOff = buf.readUInt32LE(0x3c)
  if (peOff + 24 > buf.length) return null
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') return null

  const fileHeaderOff = peOff + 4
  const machine = buf.readUInt16LE(fileHeaderOff)
  const numSections = buf.readUInt16LE(fileHeaderOff + 2)
  const sizeOfOptionalHeader = buf.readUInt16LE(fileHeaderOff + 16)

  const optHeaderOff = fileHeaderOff + 20
  if (optHeaderOff + 2 > buf.length) return null
  const magic = buf.readUInt16LE(optHeaderOff)
  const dataDirOff =
    magic === OPTIONAL_MAGIC_PE32PLUS ? optHeaderOff + 112 : magic === OPTIONAL_MAGIC_PE32 ? optHeaderOff + 96 : -1
  if (dataDirOff < 0 || dataDirOff + 8 > buf.length) return null
  const exportDirRva = buf.readUInt32LE(dataDirOff)
  const exportDirSize = buf.readUInt32LE(dataDirOff + 4)

  const sectionTableOff = optHeaderOff + sizeOfOptionalHeader
  const sections: Section[] = []
  for (let s = 0; s < numSections; s++) {
    const off = sectionTableOff + s * 40
    if (off + 40 > buf.length) return null
    sections.push({
      virtualAddress: buf.readUInt32LE(off + 12),
      virtualSize: buf.readUInt32LE(off + 8),
      sizeOfRawData: buf.readUInt32LE(off + 16),
      pointerToRawData: buf.readUInt32LE(off + 20),
    })
  }
  return { machine, sections, exportDirRva, exportDirSize }
}

/** RVA → offset file: sezione con VirtualAddress <= rva < VirtualAddress+max(raw,virtual). */
function rvaToFileOffset(pe: PeInfo, rva: number): number | null {
  for (const s of pe.sections) {
    const span = Math.max(s.sizeOfRawData, s.virtualSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      return rva - s.virtualAddress + s.pointerToRawData
    }
  }
  return null
}

function readCString(buf: Buffer, off: number, maxLen: number): string {
  let end = off
  while (end < buf.length && end < off + maxLen && buf[end] !== 0) end++
  return buf.toString('latin1', off, end)
}

/**
 * Risolve un export per NOME nella Export Directory Table. L'indice trovato in AddressOfNames
 * si usa per leggere AddressOfNameOrdinals[i] (WORD): quel valore è GIÀ l'indice diretto dentro
 * AddressOfFunctions (non richiede sommare/sottrarre Base — verificato su fonte primaria).
 * Ritorna l'offset file del target, o null se il nome non esiste / è un forwarder (punta
 * dentro la Export Directory stessa: forwarder string, non dati/codice reali).
 */
function resolveExportByName(buf: Buffer, pe: PeInfo, name: string): number | null {
  if (pe.exportDirRva === 0 || pe.exportDirSize === 0) return null
  const dirOff = rvaToFileOffset(pe, pe.exportDirRva)
  if (dirOff === null || dirOff + 40 > buf.length) return null

  const numberOfNames = buf.readUInt32LE(dirOff + 24)
  const addressOfFunctionsRva = buf.readUInt32LE(dirOff + 28)
  const addressOfNamesRva = buf.readUInt32LE(dirOff + 32)
  const addressOfNameOrdinalsRva = buf.readUInt32LE(dirOff + 36)

  const namesOff = rvaToFileOffset(pe, addressOfNamesRva)
  const ordsOff = rvaToFileOffset(pe, addressOfNameOrdinalsRva)
  const funcsOff = rvaToFileOffset(pe, addressOfFunctionsRva)
  if (namesOff === null || ordsOff === null || funcsOff === null) return null

  for (let i = 0; i < numberOfNames; i++) {
    if (namesOff + i * 4 + 4 > buf.length) return null
    const nameRva = buf.readUInt32LE(namesOff + i * 4)
    const nameOff = rvaToFileOffset(pe, nameRva)
    if (nameOff === null) continue
    if (readCString(buf, nameOff, 256) !== name) continue

    if (ordsOff + i * 2 + 2 > buf.length) return null
    const ord = buf.readUInt16LE(ordsOff + i * 2)
    if (funcsOff + ord * 4 + 4 > buf.length) return null
    const funcRva = buf.readUInt32LE(funcsOff + ord * 4)
    // Forwarder (RVA dentro la export directory stessa): non punta a dati reali.
    if (funcRva >= pe.exportDirRva && funcRva < pe.exportDirRva + pe.exportDirSize) return null
    return rvaToFileOffset(pe, funcRva)
  }
  return null
}

/** REL::Version::unpack — major(8bit) minor(8bit) patch(12bit) build(4bit) → "A.B.C.D". */
export function unpackVersion(packed: number): string {
  const major = (packed >>> 24) & 0xff
  const minor = (packed >>> 16) & 0xff
  const patch = (packed >>> 4) & 0xfff
  const build = packed & 0xf
  return `${major}.${minor}.${patch}.${build}`
}

const ADDRESS_LIBRARY_POST_AE = 1 << 0
const SIGNATURE_SCANNING = 1 << 1
const STRUCTS_POST_629 = 1 << 2
const NO_STRUCT_USE = 1 << 0

export interface PluginVersionData {
  dataVersion: number
  pluginVersion: string
  name: string
  author: string
  supportEmail: string
  noStructUse: boolean
  addressLibrary: boolean
  signatureScanning: boolean
  structsPost629: boolean
  compatibleVersions: string[] // lista terminata da 0, già decodificata, esclusi gli zeri finali
  xseMinimum: string
}

/** Legge la struct SKSE::PluginVersionData (0x350 byte) a partire da un offset file. */
function readPluginVersionData(buf: Buffer, off: number): PluginVersionData | null {
  if (off < 0 || off + PLUGIN_VERSION_DATA_SIZE > buf.length) return null
  const dataVersion = buf.readUInt32LE(off + 0x000)
  const pluginVersion = buf.readUInt32LE(off + 0x004)
  const name = readCString(buf, off + 0x008, 256)
  const author = readCString(buf, off + 0x108, 256)
  const supportEmail = readCString(buf, off + 0x208, 252)
  const versionIndependenceEx = buf.readUInt32LE(off + 0x304)
  const versionIndependence = buf.readUInt32LE(off + 0x308)
  const compatibleVersions: string[] = []
  for (let i = 0; i < 16; i++) {
    const v = buf.readUInt32LE(off + 0x30c + i * 4)
    if (v === 0) break
    compatibleVersions.push(unpackVersion(v))
  }
  const xseMinimum = buf.readUInt32LE(off + 0x34c)
  return {
    dataVersion,
    pluginVersion: unpackVersion(pluginVersion),
    name,
    author,
    supportEmail,
    noStructUse: (versionIndependenceEx & NO_STRUCT_USE) !== 0,
    addressLibrary: (versionIndependence & ADDRESS_LIBRARY_POST_AE) !== 0,
    signatureScanning: (versionIndependence & SIGNATURE_SCANNING) !== 0,
    structsPost629: (versionIndependence & STRUCTS_POST_629) !== 0,
    compatibleVersions,
    xseMinimum: unpackVersion(xseMinimum),
  }
}

export type SkseDllVerdict = 'ok' | 'warning' | 'incompatible' | 'unknown'

export interface SkseDllReport {
  file: string
  verdict: SkseDllVerdict
  reason: string
  data: PluginVersionData | null
  hasLoadExport: boolean
}

/**
 * Classifica un singolo DLL SKSE. `runtimeVersion` (es. "1.6.1170.0", da peVersion.ts sull'exe
 * di gioco) è opzionale: senza di esso si valida solo la struct in sé (architettura, presenza
 * export, dataVersion), senza poter giudicare compatibleVersions[].
 */
export function classifySkseDll(buf: Buffer, runtimeVersion?: string | null): Omit<SkseDllReport, 'file'> {
  const pe = parsePe(buf)
  if (!pe) return { verdict: 'unknown', reason: 'non un PE valido', data: null, hasLoadExport: false }
  if (pe.machine !== MACHINE_AMD64) {
    return {
      verdict: 'incompatible',
      reason: `architettura non-x64 (Machine=0x${pe.machine.toString(16)}) — probabile DLL Oldrim/32-bit, causerebbe Errore 193 di Windows`,
      data: null,
      hasLoadExport: false,
    }
  }
  const hasLoadExport = resolveExportByName(buf, pe, 'SKSEPlugin_Load') !== null
  const versionOff = resolveExportByName(buf, pe, 'SKSEPlugin_Version')
  if (versionOff === null) {
    // Nessun export dati SKSEPlugin_Version: può essere un plugin che usa solo la Query API
    // storica (pre-AE) — non è di per sé un errore, ma niente da validare staticamente.
    return { verdict: 'unknown', reason: 'nessun export "SKSEPlugin_Version" (API storica Query-only?)', data: null, hasLoadExport }
  }
  const data = readPluginVersionData(buf, versionOff)
  if (!data) {
    return { verdict: 'unknown', reason: 'export "SKSEPlugin_Version" trovato ma struct illeggibile/troncata', data: null, hasLoadExport }
  }
  if (data.dataVersion !== 1) {
    return {
      verdict: 'warning',
      reason: `dataVersion=${data.dataVersion} sconosciuto (kVersion atteso: 1) — struct potrebbe essere letta in modo scorretto`,
      data,
      hasLoadExport,
    }
  }
  if (runtimeVersion) {
    const anyVersionIndependent = data.noStructUse || data.addressLibrary || data.signatureScanning || data.structsPost629
    const declaresCompat = data.compatibleVersions.includes(runtimeVersion)
    if (!declaresCompat && !anyVersionIndependent) {
      return {
        verdict: 'incompatible',
        reason: `nessuna versione compatibile dichiarata include il runtime ${runtimeVersion} (compatibili: ${data.compatibleVersions.join(', ') || 'nessuna'}) e nessun flag version-independent impostato — SKSE stesso rifiuterebbe questo plugin`,
        data,
        hasLoadExport,
      }
    }
  }
  return { verdict: 'ok', reason: 'struct valida, compatibilità dichiarata verificata', data, hasLoadExport }
}

/** Legge e classifica un DLL dal filesystem. Mai throw: errori I/O → verdict 'unknown'. */
export function readAndClassifySkseDll(filePath: string, runtimeVersion?: string | null): SkseDllReport {
  try {
    const buf = readFileSync(filePath)
    return { file: filePath, ...classifySkseDll(buf, runtimeVersion) }
  } catch (e) {
    return { file: filePath, verdict: 'unknown', reason: `lettura fallita: ${(e as Error).message}`, data: null, hasLoadExport: false }
  }
}
