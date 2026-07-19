// Scansione record-per-record per il conflict detector (CONFLICTS Fase 1) — PURO sulla
// Buffer. Estende il walk lineare di eslify (scanPluginRecords) emettendo OGNI record
// (TES4 escluso) con signature, FormID, flags, CRC32 del payload e EDID: i dati minimi
// per rilevare i conflitti logici (stesso FormID risolto toccato da più plugin) SENZA
// decodificare la semantica per-tipo dei subrecord (quella resta dominio di xEdit).
//
// Fatti di formato (UESP Skyrim_Mod:Mod_File_Format, xEdit wbDefinitionsTES5, già
// verificati per espParser/eslify 2026-07-18):
//   • header record 24 byte: 4cc, dataSize u32le, flags u32le, formId u32le, vc u32,
//     formVersion u16, unknown u16;
//   • flag record 0x00040000 = payload compresso: u32le dimensione decompressa seguita
//     dallo stream zlib/deflate;
//   • GRUP: header 24 byte, groupSize INCLUDE l'header, contenuto sequenziale — il walk
//     lineare salta solo l'header (stessa strategia provata di eslify);
//   • subrecord: 4cc + size u16le + payload; 'XXXX' (size 4, payload u32) dichiara la
//     dimensione reale del subrecord successivo (il cui size u16 è 0).
//
// Il CRC è calcolato sul payload DECOMPRESSO quando l'inflate riesce: due plugin che
// scrivono lo stesso record con livelli zlib diversi devono produrre lo stesso hash
// (rilevazione identical-override). Guardie di sicurezza sulla decompressione:
// maxOutputLength = dimensione dichiarata (inflate che eccede → throw, mai OOM) e cap
// assoluto MAX_DECOMP contro header con dichiarazione folle (zip-bomb / file corrotto).

import { inflateSync } from 'node:zlib'
import { crc32 } from '../plugins/crc32'
import { parsePluginHeader, type PluginHeader } from '../plugins/espParser'

const RECORD_HEADER_SIZE = 24
const GRUP_HEADER_SIZE = 24
const FLAG_COMPRESSED = 0x0004_0000
// Il record compresso più grande nei plugin reali sta nell'ordine dei MB (NAVM/LAND/WRLD);
// 128 MiB è una guardia di sanità contro dichiarazioni corrotte, non un vincolo di formato.
const MAX_DECOMP = 128 * 1024 * 1024

export interface ScannedRecord {
  signature: string
  formId: number
  flags: number
  /** CRC32 del payload (decompresso se il record è compresso e l'inflate riesce). */
  dataCrc: number
  /** EDID (editor id) se presente nel payload — solo per display, mai per identità. */
  edid: string | null
  /** true = flag compresso presente ma inflate fallito/incoerente: dataCrc è sul payload RAW. */
  compressedBad: boolean
  /** Offset del payload RAW nel file (dopo l'header record) — per riletture mirate (recordDiff). */
  dataOffset: number
  /** Dimensione del payload RAW nel file (compresso se il record è compresso). */
  dataSize: number
}

export interface RecordScanResult {
  /** Parse completo e allineato fino all'ultimo byte (stesso contratto di eslify). */
  parsed: boolean
  /** Header TES4 (masters, flags, HEDR version) — null se il file non è un plugin. */
  header: PluginHeader | null
  /** Record emessi via onRecord (anche in caso di parse poi fallito: il chiamante scarta). */
  records: number
  compressedBadCount: number
}

/** Cerca il subrecord EDID (zstring) nel payload di un record. Malformazioni → null, mai throw. */
export function extractEdid(data: Buffer): string | null {
  let off = 0
  let pendingSize: number | null = null
  while (off + 6 <= data.length) {
    const type = data.toString('ascii', off, off + 4)
    let size = data.readUInt16LE(off + 4)
    const start = off + 6
    if (type === 'XXXX' && size === 4) {
      if (start + 4 > data.length) return null
      pendingSize = data.readUInt32LE(start)
      off = start + 4
      continue
    }
    if (pendingSize !== null) {
      size = pendingSize
      pendingSize = null
    }
    if (start + size > data.length) return null
    if (type === 'EDID') {
      let z = start
      while (z < start + size && data[z] !== 0) z++
      const name = data.toString('utf8', start, z).trim()
      return name || null
    }
    off = start + size
  }
  return null
}

/** Payload effettivo di un record (decompresso se serve) + esito della decompressione. */
export function recordPayload(raw: Buffer, flags: number): { payload: Buffer; compressedBad: boolean } {
  if ((flags & FLAG_COMPRESSED) === 0) return { payload: raw, compressedBad: false }
  if (raw.length < 4) return { payload: raw, compressedBad: true }
  const declared = raw.readUInt32LE(0)
  if (declared > MAX_DECOMP) return { payload: raw, compressedBad: true }
  try {
    const out = inflateSync(raw.subarray(4), { maxOutputLength: declared })
    if (out.length !== declared) return { payload: raw, compressedBad: true }
    return { payload: out, compressedBad: false }
  } catch {
    return { payload: raw, compressedBad: true }
  }
}

/**
 * Cammina l'intero plugin ed emette ogni record via callback (streaming: mai un array
 * dell'intero Skyrim.esm in memoria qui — l'accumulo è del chiamante). Qualsiasi
 * disallineamento → parsed:false; il chiamante DEVE scartare i record emessi fino a lì
 * (un indice parziale produrrebbe falsi "nessun conflitto").
 *
 * Il callback può ritornare `true` per FERMARE il walk (lookup mirato di un singolo
 * record, vedi recordDiff): in quel caso parsed=true — lo stop è intenzionale, non
 * un'anomalia del file.
 */
export function scanRecordsForConflicts(
  buf: Buffer,
  onRecord: (r: ScannedRecord) => void | boolean,
): RecordScanResult {
  const header = parsePluginHeader(buf)
  let records = 0
  let compressedBadCount = 0
  const fail = (): RecordScanResult => ({ parsed: false, header, records, compressedBadCount })
  if (!header || buf.length < RECORD_HEADER_SIZE) return fail()

  const tes4Size = buf.readUInt32LE(4)
  let pos = RECORD_HEADER_SIZE + tes4Size
  while (pos < buf.length) {
    if (pos + RECORD_HEADER_SIZE > buf.length) return fail()
    const type = buf.toString('ascii', pos, pos + 4)
    if (!/^[A-Z0-9_]{4}$/.test(type)) return fail()
    if (type === 'GRUP') {
      const groupSize = buf.readUInt32LE(pos + 4)
      if (groupSize < GRUP_HEADER_SIZE || pos + groupSize > buf.length) return fail()
      pos += GRUP_HEADER_SIZE
      continue
    }
    const dataSize = buf.readUInt32LE(pos + 4)
    const flags = buf.readUInt32LE(pos + 8)
    const formId = buf.readUInt32LE(pos + 12)
    const dataStart = pos + RECORD_HEADER_SIZE
    if (dataStart + dataSize > buf.length) return fail()
    const raw = buf.subarray(dataStart, dataStart + dataSize)
    const { payload, compressedBad } = recordPayload(raw, flags)
    if (compressedBad) compressedBadCount++
    records++
    const stop = onRecord({
      signature: type,
      formId,
      flags,
      dataCrc: crc32(payload),
      edid: extractEdid(payload),
      compressedBad,
      dataOffset: dataStart,
      dataSize,
    })
    if (stop === true) return { parsed: true, header, records, compressedBadCount }
    pos = dataStart + dataSize
  }
  return { parsed: pos === buf.length, header, records, compressedBadCount }
}
