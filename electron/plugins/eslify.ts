// ESL-ify (ESLIFY-01) — libera slot FULL del load order flaggando "light" i plugin
// che possono diventarlo SENZA compattare FormID: i pure-override.
//
// Contesto motore: gli slot FULL (ESM/ESP non-light) sono max 254 TOTALI; i light
// vivono nello slot FE (max 4096). Il flag light (bit 0x200 del record TES4) vincola
// SOLO i record NUOVI del plugin (FormID nello spazio proprio): un plugin che
// contiene esclusivamente OVERRIDE di record altrui (il classico patch di
// compatibilità) non ha alcun vincolo di range e può essere flaggato cambiando
// UN bit dell'header — la pratica standard degli "ESLify script" per xEdit.
//
// Criterio di eleggibilità (CONSERVATIVO, tutto verificato sul file reale):
//   • estensione .esp, flag light assente, flag ESM assente (i master non si toccano);
//   • il file si parse INTERO senza anomalie (record/GRUP allineati fino all'ultimo byte);
//   • ZERO record nuovi: ogni FormID ha master-index < numero dei MAST dell'header.
// Nessun record nuovo ⇒ nessun FormID da compattare ⇒ nessun riferimento esterno
// possibile verso lo spazio proprio del plugin ⇒ flag sicuro anche per i dipendenti.
// NB per i salvataggi: cambiare full→light sposta i FormID propri nello spazio FE —
// con zero record propri non c'è nulla da spostare, il save non vede differenze.
//
// PURO sulla Buffer; l'IO (lettura/backup/scrittura del bit) è del chiamante/engine.

const FLAG_ESM = 0x0000_0001
const FLAG_LIGHT = 0x0000_0200
const RECORD_HEADER_SIZE = 24
const GRUP_HEADER_SIZE = 24

export interface PluginScanInfo {
  /** Parse completo e pulito fino all'ultimo byte. */
  parsed: boolean
  isEsm: boolean
  isLight: boolean
  masterCount: number
  /** Record con FormID nello spazio PROPRIO del plugin (nuovi, non override). */
  ownRecords: number
  /** Record totali (TES4 escluso). */
  totalRecords: number
  /** Conteggio per valore di formVersion (campo u16 a offset 0x14 dell'header record: 43=LE, 44=SE/AE). */
  formVersionCounts: Record<number, number>
  /** Object-index (12 bit bassi del FormID) di ogni record PROPRIO — usato da espValidate per il range ESL. */
  ownRecordObjectIndices: number[]
}

/**
 * Cammina l'intero file: record e GRUP sono sequenziali (il contenuto di un GRUP
 * segue il suo header), quindi basta una scansione lineare. Qualsiasi disallineamento
 * → parsed:false (file NON candidato, mai un flag su un parse incerto).
 */
export function scanPluginRecords(buf: Buffer): PluginScanInfo {
  const bad: PluginScanInfo = {
    parsed: false,
    isEsm: false,
    isLight: false,
    masterCount: 0,
    ownRecords: 0,
    totalRecords: 0,
    formVersionCounts: {},
    ownRecordObjectIndices: [],
  }
  if (buf.length < RECORD_HEADER_SIZE || buf.toString('ascii', 0, 4) !== 'TES4') return bad
  const tes4Size = buf.readUInt32LE(4)
  const flags = buf.readUInt32LE(8)
  const isEsm = (flags & FLAG_ESM) !== 0
  const isLight = (flags & FLAG_LIGHT) !== 0

  // Conta i MAST dentro il payload TES4 (stesso formato di espParser, qui serve solo il numero).
  let masterCount = 0
  {
    const end = RECORD_HEADER_SIZE + tes4Size
    if (end > buf.length) return bad
    let off = RECORD_HEADER_SIZE
    let pendingSize: number | null = null
    while (off < end) {
      if (off + 6 > end) return bad
      const type = buf.toString('ascii', off, off + 4)
      let size = buf.readUInt16LE(off + 4)
      const dataStart = off + 6
      if (type === 'XXXX' && size === 4) {
        if (dataStart + 4 > end) return bad
        pendingSize = buf.readUInt32LE(dataStart)
        off = dataStart + 4
        continue
      }
      if (pendingSize !== null) {
        size = pendingSize
        pendingSize = null
      }
      if (dataStart + size > end) return bad
      if (type === 'MAST') masterCount++
      off = dataStart + size
    }
  }

  let ownRecords = 0
  let totalRecords = 0
  const formVersionCounts: Record<number, number> = {}
  const ownRecordObjectIndices: number[] = []
  let pos = RECORD_HEADER_SIZE + tes4Size
  while (pos < buf.length) {
    if (pos + RECORD_HEADER_SIZE > buf.length) return bad
    const type = buf.toString('ascii', pos, pos + 4)
    if (!/^[A-Z0-9_]{4}$/.test(type)) return bad
    if (type === 'GRUP') {
      // groupSize INCLUDE l'header: il contenuto segue sequenziale, si salta solo l'header.
      const groupSize = buf.readUInt32LE(pos + 4)
      if (groupSize < GRUP_HEADER_SIZE || pos + groupSize > buf.length) return bad
      pos += GRUP_HEADER_SIZE
      continue
    }
    const dataSize = buf.readUInt32LE(pos + 4)
    const formId = buf.readUInt32LE(pos + 12)
    const formVersion = buf.readUInt16LE(pos + 20) // offset 0x14, u16LE (vedi RE::FORM/CommonLibSSE-NG)
    totalRecords++
    formVersionCounts[formVersion] = (formVersionCounts[formVersion] ?? 0) + 1
    if (formId >>> 24 >= masterCount) {
      ownRecords++
      ownRecordObjectIndices.push(formId & 0xfff)
    }
    pos += RECORD_HEADER_SIZE + dataSize
    if (pos > buf.length) return bad
  }
  return {
    parsed: pos === buf.length,
    isEsm,
    isLight,
    masterCount,
    ownRecords,
    totalRecords,
    formVersionCounts,
    ownRecordObjectIndices,
  }
}

export interface EslCandidate {
  name: string
  src: string
  size: number
  eligible: boolean
  reason: string
  totalRecords?: number
}

/** Classifica un plugin (nome file + contenuto) come candidato ESL-flag o no. */
export function classifyForEsl(name: string, buf: Buffer): Omit<EslCandidate, 'src' | 'size'> {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.esp')) return { name, eligible: false, reason: 'non .esp' }
  const s = scanPluginRecords(buf)
  if (!s.parsed) return { name, eligible: false, reason: 'parse incompleto/anomalo' }
  if (s.isLight) return { name, eligible: false, reason: 'già light' }
  if (s.isEsm) return { name, eligible: false, reason: 'ESM-flagged (master non toccati)' }
  if (s.ownRecords > 0)
    return { name, eligible: false, reason: `${s.ownRecords} record nuovi (serve compattazione FormID)` }
  return { name, eligible: true, reason: 'pure override: zero record nuovi', totalRecords: s.totalRecords }
}

/**
 * Sceglie quali candidati flaggare per liberare `slotsToFree` slot FULL: i file più
 * PICCOLI prima (patch minimali, rischio e I/O minimi), ordine stabile per nome.
 */
export function pickToFlag(candidates: EslCandidate[], slotsToFree: number): EslCandidate[] {
  if (slotsToFree <= 0) return []
  return candidates
    .filter((c) => c.eligible)
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name))
    .slice(0, slotsToFree)
}

/** Applica il flag light alla Buffer (bit 0x200 dell'u32 flags a offset 8). */
export function setLightFlag(buf: Buffer): void {
  buf.writeUInt32LE(buf.readUInt32LE(8) | FLAG_LIGHT, 8)
}

/** I 4 byte del campo flags con il bit light acceso (per scritture chirurgiche su fd). */
export function lightFlagBytes(currentFlags: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(currentFlags | FLAG_LIGHT, 0)
  return b
}

/** Offset del campo flags nel file (u32le dentro l'header del record TES4). */
export const TES4_FLAGS_OFFSET = 8
