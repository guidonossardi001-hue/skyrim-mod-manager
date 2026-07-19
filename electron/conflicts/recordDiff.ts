// Diff STRUTTURALE del singolo record conteso (CONFLICTS Fase 3) — nativo, on-demand.
//
// Per un record selezionato nella UI, estrae da OGNI plugin partecipante la sequenza di
// subrecord (type, size, CRC32, anteprima esadecimale) e allinea le sequenze in righe di
// diff: quali subrecord differiscono tra i partecipanti, quali mancano, quali sono
// identici. NON decodifica la semantica per-campo dei singoli tipi record (dominio di
// xEdit, dove avviene la risoluzione vera): dice DOVE i partecipanti divergono, che è
// quanto serve per decidere se un conflitto va patchato e cosa portarsi nella patch.
//
// Costo: un walk lineare con early-stop per partecipante (il lookup si ferma al match).
// Nessuna migrazione dell'indice: il record si ritrova ricalcolando la formKey durante
// il walk, con la STESSA regola di mask light usata all'indicizzazione (coerenza chiavi).
//
// Allineamento subrecord ripetuti (es. N condizioni CTDA): chiave = type + numero di
// occorrenza nella sequenza del singolo partecipante. L'ordine delle righe segue il
// VINCITORE del load order (ultimo partecipante), poi le chiavi presenti solo altrove.

import { readFileSync } from 'node:fs'
import { crc32 } from '../plugins/crc32'
import { parsePluginHeader } from '../plugins/espParser'
import { scanRecordsForConflicts, recordPayload, type ScannedRecord } from './recordScan'
import { resolveFormKey } from './formKey'

const PREVIEW_BYTES = 16

export interface SubrecordCell {
  type: string
  /** Occorrenza (1-based) di questo type nella sequenza del partecipante. */
  occurrence: number
  size: number
  crc: number
  /** Primi byte del payload in esadecimale (max PREVIEW_BYTES), per orientarsi a occhio. */
  previewHex: string
}

export interface RecordSnapshot {
  plugin: string
  displayName: string
  found: boolean
  /** true = record compresso ma inflate fallito: subrecord non estraibili. */
  compressedBad: boolean
  signature: string | null
  edid: string | null
  subrecords: SubrecordCell[]
}

export interface RecordDiffRow {
  /** Chiave di allineamento: `TYPE` o `TYPE#n` per le occorrenze successive alla prima. */
  key: string
  /** true = almeno un partecipante ha CRC diverso o non ha il subrecord. */
  differs: boolean
  /** Una cella per partecipante, nell'ordine di snapshots; null = subrecord assente. */
  cells: (SubrecordCell | null)[]
}

/** Sequenza subrecord di un payload (XXXX-aware, stessa grammatica di extractEdid). Malformazioni → stop silenzioso. */
export function parseSubrecords(payload: Buffer): SubrecordCell[] {
  const out: SubrecordCell[] = []
  const occurrences = new Map<string, number>()
  let off = 0
  let pendingSize: number | null = null
  while (off + 6 <= payload.length) {
    const type = payload.toString('ascii', off, off + 4)
    if (!/^[A-Z0-9_]{4}$/.test(type)) break
    let size = payload.readUInt16LE(off + 4)
    const start = off + 6
    if (type === 'XXXX' && size === 4) {
      if (start + 4 > payload.length) break
      pendingSize = payload.readUInt32LE(start)
      off = start + 4
      continue // XXXX è un prefisso tecnico, non un subrecord da mostrare
    }
    if (pendingSize !== null) {
      size = pendingSize
      pendingSize = null
    }
    if (start + size > payload.length) break
    const occ = (occurrences.get(type) ?? 0) + 1
    occurrences.set(type, occ)
    const data = payload.subarray(start, start + size)
    out.push({
      type,
      occurrence: occ,
      size,
      crc: crc32(data),
      previewHex: data.subarray(0, PREVIEW_BYTES).toString('hex'),
    })
    off = start + size
  }
  return out
}

export interface SnapshotTarget {
  /** Nome file lowercase (chiave interna dell'indice). */
  plugin: string
  displayName: string
  path: string
}

/**
 * Estrae lo snapshot del record `formKey` da un singolo plugin: walk con early-stop
 * (si ferma al primo record la cui formKey ricalcolata coincide). Mai throw.
 */
export function snapshotRecord(
  target: SnapshotTarget,
  formKey: string,
  isLight: (name: string) => boolean | undefined,
): RecordSnapshot {
  const notFound: RecordSnapshot = {
    plugin: target.plugin,
    displayName: target.displayName,
    found: false,
    compressedBad: false,
    signature: null,
    edid: null,
    subrecords: [],
  }
  let buf: Buffer
  try {
    buf = readFileSync(target.path)
  } catch {
    return notFound
  }
  // Header PRIMA del walk: la formKey di ogni record dipende dalla lista MAST.
  const header = parsePluginHeader(buf)
  if (!header) return notFound
  const masters = header.masters
  let hit: ScannedRecord | null = null
  scanRecordsForConflicts(buf, (r) => {
    const resolved = resolveFormKey(r.formId, { pluginName: target.displayName, masters, isLight })
    if (resolved.key === formKey) {
      hit = r
      return true
    }
    return false
  })
  if (!hit) return notFound
  const rec = hit as ScannedRecord
  const raw = buf.subarray(rec.dataOffset, rec.dataOffset + rec.dataSize)
  const { payload, compressedBad } = recordPayload(raw, rec.flags)
  return {
    plugin: target.plugin,
    displayName: target.displayName,
    found: true,
    compressedBad,
    signature: rec.signature,
    edid: rec.edid,
    subrecords: compressedBad ? [] : parseSubrecords(payload),
  }
}

/** Allinea gli snapshot in righe di diff, nell'ordine del vincitore (ultimo snapshot). */
export function buildDiffRows(snapshots: RecordSnapshot[]): RecordDiffRow[] {
  const keyOf = (c: SubrecordCell) => (c.occurrence === 1 ? c.type : `${c.type}#${c.occurrence}`)
  const maps = snapshots.map((s) => {
    const m = new Map<string, SubrecordCell>()
    for (const c of s.subrecords) m.set(keyOf(c), c)
    return m
  })
  // Ordine righe: sequenza del vincitore (ultimo snapshot TROVATO), poi chiavi orfane.
  const orderedKeys: string[] = []
  const seen = new Set<string>()
  const push = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k)
      orderedKeys.push(k)
    }
  }
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].found) {
      for (const c of snapshots[i].subrecords) push(keyOf(c))
      break
    }
  }
  for (const s of snapshots) for (const c of s.subrecords) push(keyOf(c))

  return orderedKeys.map((key) => {
    const cells = maps.map((m, i) => (snapshots[i].found ? (m.get(key) ?? null) : null))
    const present = cells.filter((c): c is SubrecordCell => c !== null)
    const someMissing = snapshots.some((s, i) => s.found && !s.compressedBad && cells[i] === null)
    const crcs = new Set(present.map((c) => c.crc))
    return { key, differs: someMissing || crcs.size > 1, cells }
  })
}
