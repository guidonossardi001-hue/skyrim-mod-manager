import { describe, it, expect } from 'vitest'
import { crc32, crc32Update, crc32Finalize, CRC32_INIT } from './crc32'

describe('crc32', () => {
  it('vettore di test standard IEEE 802.3: "123456789" -> 0xCBF43926', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
  it('stringa vuota -> 0', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
  it('streaming su più chunk == risultato su buffer intero', () => {
    const full = Buffer.from('the quick brown fox jumps over the lazy dog')
    const a = full.subarray(0, 10)
    const b = full.subarray(10)
    let acc = CRC32_INIT
    acc = crc32Update(acc, a)
    acc = crc32Update(acc, b)
    expect(crc32Finalize(acc)).toBe(crc32(full))
  })
})
