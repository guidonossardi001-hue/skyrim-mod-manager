// CRC32 (IEEE 802.3, polinomio 0xEDB88320) — stessa checksum che LOOT/xEdit usano per
// identificare la VERSIONE ESATTA di un plugin nel masterlist (campo `crc` in `dirty:`).
// Implementazione pura standard, nessuna dipendenza: la tabella è generata una volta a
// module-load, l'update è streaming-friendly (accumula su chunk successivi).

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Stato iniziale di un accumulo CRC32 streaming (vedi crc32Update/crc32Finalize). */
export const CRC32_INIT = 0xffffffff

/** Aggiorna un accumulo CRC32 con un nuovo chunk. Concatenabile su più chunk in ordine. */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = crc
  for (let i = 0; i < chunk.length; i++) c = TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

/** Converte lo stato accumulato nel CRC32 finale (unsigned 32-bit). */
export function crc32Finalize(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0
}

/** CRC32 di un buffer intero in un colpo solo. */
export function crc32(data: Uint8Array): number {
  return crc32Finalize(crc32Update(CRC32_INIT, data))
}
