// Decoder LZ4 raw block (formato usato dai salvataggi Skyrim SE, uiCompression=2).
// Node non ha LZ4 nativo e una dipendenza nativa per 40 righe non vale il costo di
// supply-chain: il block format è documentato e stabile (token 4+4 bit, literals,
// match offset u16le, minmatch 4). PURO, difensivo: qualsiasi input malformato → null,
// mai throw, mai lettura fuori dai bound.

export interface Lz4Options {
  /** true = decodifica SOLO i primi dstSize byte e fermati (prefix decode): i salvataggi
   *  hanno la lista plugin nei primi KB del corpo, inutile decomprimere decine di MB. */
  partial?: boolean
}

export function decodeLz4Block(src: Buffer, dstSize: number, opts: Lz4Options = {}): Buffer | null {
  if (dstSize < 0 || dstSize > 512 * 1024 * 1024) return null // guardia anti-alloc folle
  const partial = opts.partial === true
  const dst = Buffer.allocUnsafe(dstSize)
  let s = 0 // cursore sorgente
  let d = 0 // cursore destinazione
  const sn = src.length

  while (s < sn) {
    const token = src[s++]
    // Literals: high nibble (15 = lunghezza estesa a byte successivi).
    let litLen = token >>> 4
    if (litLen === 15) {
      let b: number
      do {
        if (s >= sn) return null
        b = src[s++]
        litLen += b
      } while (b === 255)
    }
    if (s + litLen > sn) return null
    if (d + litLen > dstSize) {
      if (!partial) return null
      src.copy(dst, d, s, s + (dstSize - d))
      return dst
    }
    src.copy(dst, d, s, s + litLen)
    s += litLen
    d += litLen

    // L'ultimo blocco termina con soli literals (nessun match).
    if (s >= sn) break

    if (s + 2 > sn) return null
    const offset = src.readUInt16LE(s)
    s += 2
    if (offset === 0 || offset > d) return null

    // Match: low nibble + 4 (minmatch), 15 = esteso.
    let matchLen = (token & 0x0f) + 4
    if ((token & 0x0f) === 15) {
      let b: number
      do {
        if (s >= sn) return null
        b = src[s++]
        matchLen += b
      } while (b === 255)
    }
    if (d + matchLen > dstSize && !partial) return null
    // Copia byte-a-byte: i match possono sovrapporsi (offset < matchLen è legale in LZ4).
    let from = d - offset
    const end = Math.min(d + matchLen, dstSize)
    while (d < end) dst[d++] = dst[from++]
    if (d >= dstSize) return dst
  }

  return d === dstSize ? dst : dst.subarray(0, d)
}
