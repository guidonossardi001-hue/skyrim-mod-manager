// Parser dell'header TES4 dei plugin Bethesda (.esm/.esp/.esl) — PURO sulla Buffer,
// con un piccolo wrapper fs che legge SOLO l'header (mai il file intero: un plugin
// può pesare centinaia di MB, l'header TES4 sta nei primi KB).
//
// È la fonte di verità del load order LOOT-like: i master REALI di un plugin stanno
// nei subrecord MAST del suo record TES4, non nel campo `requires` del catalogo
// (che è una stima a livello di MOD, con id storicamente inaffidabili). Formato
// Skyrim SE: header record da 24 byte ("TES4", dataSize u32le, flags u32le, formId,
// vc, version u16, unknown u16) seguito da `dataSize` byte di subrecord
// (type 4cc, size u16le, payload).

import { openSync, readSync, closeSync } from 'fs'

/** Flag del record TES4 (non del filename): l'ENGINE decide da questi, non dall'estensione. */
const FLAG_ESM = 0x0000_0001
const FLAG_LIGHT = 0x0000_0200

const RECORD_HEADER_SIZE = 24
// Un TES4 reale sta in pochi KB anche con centinaia di master; 1 MiB è un limite
// di sanità contro dataSize corrotti, non un vincolo di formato.
const MAX_HEADER_PAYLOAD = 1024 * 1024

export interface PluginHeader {
  isEsm: boolean // flag ESM: il plugin vive nello spazio master (caricato prima dei regular)
  isLight: boolean // flag ESL/light: slot FE, NON cambia la partizione del load order
  masters: string[] // nomi file dei master richiesti, nell'ordine dei subrecord MAST
  version: number | null // HEDR version (0.94 legacy, 1.70/1.71 SE/AE), null se assente
}

/**
 * Parse difensivo dell'header TES4 da una Buffer che parte dall'inizio del file.
 * Qualsiasi forma inattesa (magic sbagliato, subrecord troncato, dataSize folle)
 * → null, mai throw: il chiamante decide il fallback (grafo catalogo).
 */
export function parsePluginHeader(buf: Buffer): PluginHeader | null {
  if (buf.length < RECORD_HEADER_SIZE) return null
  if (buf.toString('ascii', 0, 4) !== 'TES4') return null
  const dataSize = buf.readUInt32LE(4)
  const flags = buf.readUInt32LE(8)
  if (dataSize > MAX_HEADER_PAYLOAD) return null
  // Payload disponibile: può essere parziale (lettura troncata) — si parse finché i
  // subrecord sono completi, ma un subrecord tagliato invalida il risultato (un
  // elenco master monco è PEGGIO di nessun elenco: produrrebbe falsi "ordinabile").
  const end = Math.min(buf.length, RECORD_HEADER_SIZE + dataSize)
  const masters: string[] = []
  let version: number | null = null
  let off = RECORD_HEADER_SIZE
  // Subrecord esteso: 'XXXX' (size 4, payload u32) dichiara la dimensione REALE del
  // subrecord successivo, il cui size u16 è 0 (usato p.es. dall'ONAM di USSEP, >64 KB).
  let pendingSize: number | null = null
  while (off < end) {
    if (off + 6 > end) return null // header subrecord troncato
    const type = buf.toString('ascii', off, off + 4)
    let size = buf.readUInt16LE(off + 4)
    const dataStart = off + 6
    if (type === 'XXXX' && size === 4) {
      if (dataStart + 4 > end) return null
      pendingSize = buf.readUInt32LE(dataStart)
      off = dataStart + 4
      continue
    }
    if (pendingSize !== null) {
      size = pendingSize
      pendingSize = null
    }
    if (dataStart + size > end) return null // payload subrecord troncato
    if (type === 'MAST') {
      // zstring: nome file del master, null-terminated. Tollera il terminatore assente.
      let z = dataStart
      while (z < dataStart + size && buf[z] !== 0) z++
      const name = buf.toString('utf8', dataStart, z).trim()
      if (name) masters.push(name)
    } else if (type === 'HEDR' && size >= 4) {
      version = Math.round(buf.readFloatLE(dataStart) * 100) / 100
    }
    off = dataStart + size
  }
  return { isEsm: (flags & FLAG_ESM) !== 0, isLight: (flags & FLAG_LIGHT) !== 0, masters, version }
}

/**
 * Legge SOLO l'header TES4 dal file (24 byte + dataSize, cap 1 MiB) e lo parse.
 * Errori I/O o formato → null (il deploy ricade sul grafo catalogo per quel plugin).
 */
export function readPluginHeader(filePath: string): PluginHeader | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const head = Buffer.alloc(RECORD_HEADER_SIZE)
    if (readSync(fd, head, 0, RECORD_HEADER_SIZE, 0) < RECORD_HEADER_SIZE) return null
    if (head.toString('ascii', 0, 4) !== 'TES4') return null
    const dataSize = head.readUInt32LE(4)
    if (dataSize > MAX_HEADER_PAYLOAD) return null
    const full = Buffer.alloc(RECORD_HEADER_SIZE + dataSize)
    head.copy(full)
    const got = readSync(fd, full, RECORD_HEADER_SIZE, dataSize, RECORD_HEADER_SIZE)
    if (got < dataSize) return null
    return parsePluginHeader(full)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Spazio master del LOAD ORDER: l'engine carica prima tutti i plugin master-flagged.
 * L'ESTENSIONE forza il comportamento a prescindere dal flag: .esm → master,
 * .esl → master+light (regola engine SE 1.6). Il flag light da solo NON promuove.
 */
export function isMasterSpace(name: string, header: PluginHeader | null): boolean {
  const lower = name.toLowerCase()
  if (lower.endsWith('.esm') || lower.endsWith('.esl')) return true
  return header?.isEsm === true
}
