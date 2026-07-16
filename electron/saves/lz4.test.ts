import { describe, it, expect } from 'vitest'
import { decodeLz4Block } from './lz4'

// Blocchi LZ4 costruiti a mano secondo la spec del block format:
// token = (litLen<<4)|(matchLen-4), literals, offset u16le, ext bytes per len ≥ 15.

describe('decodeLz4Block', () => {
  it('blocco solo-literals (sequenza finale senza match)', () => {
    const payload = Buffer.from('abcdefgh', 'ascii')
    const block = Buffer.concat([Buffer.from([payload.length << 4]), payload])
    expect(decodeLz4Block(block, payload.length)?.toString('ascii')).toBe('abcdefgh')
  })

  it('literals estesi (len ≥ 15 → byte di estensione)', () => {
    const payload = Buffer.alloc(300, 0x41)
    // 300 = 15 + 255 + 30 → token 0xF0, ext [255, 30]
    const block = Buffer.concat([Buffer.from([0xf0, 255, 30]), payload])
    const out = decodeLz4Block(block, 300)
    expect(out?.length).toBe(300)
    expect(out?.every((b) => b === 0x41)).toBe(true)
  })

  it('literal + match: "abcd" ripetuto via offset 4', () => {
    // Sequenza 1: 4 literals 'abcd' + match len 8 offset 4 (copia sovrapposta = RLE del gruppo)
    // matchLen 8 → low nibble 4 (8-4). Poi sequenza finale vuota di literals.
    const block = Buffer.concat([
      Buffer.from([(4 << 4) | 4]),
      Buffer.from('abcd', 'ascii'),
      Buffer.from([4, 0]), // offset u16le = 4
      Buffer.from([0]), // sequenza finale: zero literals
    ])
    expect(decodeLz4Block(block, 12)?.toString('ascii')).toBe('abcdabcdabcd')
  })

  it('match sovrapposto offset 1 (RLE puro)', () => {
    const block = Buffer.concat([
      Buffer.from([(1 << 4) | 11]), // 1 literal, match 15
      Buffer.from('x', 'ascii'),
      Buffer.from([1, 0]),
      Buffer.from([0]),
    ])
    expect(decodeLz4Block(block, 16)?.toString('ascii')).toBe('x'.repeat(16))
  })

  it('modalità partial: decodifica solo il prefisso richiesto e si ferma', () => {
    const payload = Buffer.from('0123456789ABCDEF', 'ascii') // 16 byte → literals estesi
    const block = Buffer.concat([Buffer.from([0xf0, 1]), payload])
    // Prefisso dentro i literals
    expect(decodeLz4Block(block, 4, { partial: true })?.toString('ascii')).toBe('0123')
    // Prefisso dentro un match (RLE 'x' × 16, chiedo 6)
    const rle = Buffer.concat([
      Buffer.from([(1 << 4) | 11]),
      Buffer.from('x', 'ascii'),
      Buffer.from([1, 0]),
      Buffer.from([0]),
    ])
    expect(decodeLz4Block(rle, 6, { partial: true })?.toString('ascii')).toBe('xxxxxx')
    // Senza partial lo stesso prefisso resta un errore (comportamento originale intatto)
    expect(decodeLz4Block(block, 4)).toBeNull()
  })

  it('input malformati → null, mai throw', () => {
    // offset 0 (illegale)
    expect(
      decodeLz4Block(Buffer.concat([Buffer.from([(1 << 4) | 0]), Buffer.from('x'), Buffer.from([0, 0])]), 8),
    ).toBeNull()
    // offset oltre l'output prodotto
    expect(
      decodeLz4Block(Buffer.concat([Buffer.from([(1 << 4) | 0]), Buffer.from('x'), Buffer.from([9, 0])]), 8),
    ).toBeNull()
    // literals oltre la fine del sorgente
    expect(decodeLz4Block(Buffer.from([0xf0, 255]), 400)).toBeNull()
    // dstSize assurdo
    expect(decodeLz4Block(Buffer.from([0x10, 0x41]), -1)).toBeNull()
  })
})
