import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePluginHeader, readPluginHeader, isMasterSpace } from './espParser'

// Costruttore di header TES4 binari sintetici — stesso layout di Skyrim SE:
// record header 24 byte + subrecord (4cc, size u16le, payload).
function sub(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(6)
  head.write(type, 0, 'ascii')
  head.writeUInt16LE(data.length, 4)
  return Buffer.concat([head, data])
}
function zstring(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
}
function mast(name: string): Buffer {
  const data = Buffer.alloc(8) // DATA u64 (dimensione master, ignorata dal parser)
  return Buffer.concat([sub('MAST', zstring(name)), sub('DATA', data)])
}
export function buildTes4(opts: { esm?: boolean; light?: boolean; masters?: string[]; version?: number }): Buffer {
  const hedr = Buffer.alloc(12)
  hedr.writeFloatLE(opts.version ?? 1.7, 0)
  const payload = Buffer.concat([sub('HEDR', hedr), ...(opts.masters ?? []).map(mast)])
  const head = Buffer.alloc(24)
  head.write('TES4', 0, 'ascii')
  head.writeUInt32LE(payload.length, 4)
  head.writeUInt32LE((opts.esm ? 0x1 : 0) | (opts.light ? 0x200 : 0), 8)
  return Buffer.concat([head, payload])
}

describe('parsePluginHeader', () => {
  it('estrae flags e master reali dal record TES4', () => {
    const buf = buildTes4({ esm: true, masters: ['Skyrim.esm', 'Update.esm'], version: 1.71 })
    const h = parsePluginHeader(buf)!
    expect(h.isEsm).toBe(true)
    expect(h.isLight).toBe(false)
    expect(h.masters).toEqual(['Skyrim.esm', 'Update.esm'])
    expect(h.version).toBe(1.71)
  })
  it('riconosce il flag light (ESL) indipendente dal flag ESM', () => {
    const h = parsePluginHeader(buildTes4({ light: true }))!
    expect(h.isLight).toBe(true)
    expect(h.isEsm).toBe(false)
    expect(h.masters).toEqual([])
  })
  it('gestisce il subrecord esteso XXXX (size reale u32, size u16 del successivo = 0)', () => {
    // Layout reale di USSEP: ...MAST/DATA, XXXX(4, realSize), ONAM(size 0, payload realSize).
    const big = Buffer.alloc(70000, 1) // oltre il massimo u16: senza XXXX sarebbe inesprimibile
    const xxxx = Buffer.alloc(10)
    xxxx.write('XXXX', 0, 'ascii')
    xxxx.writeUInt16LE(4, 4)
    xxxx.writeUInt32LE(big.length, 6)
    const onamHead = Buffer.alloc(6)
    onamHead.write('ONAM', 0, 'ascii')
    onamHead.writeUInt16LE(0, 4) // size u16 azzerato: vale il XXXX precedente
    const base = buildTes4({ esm: true, masters: ['Skyrim.esm'] })
    const payloadExtra = Buffer.concat([xxxx, onamHead, big])
    const full = Buffer.concat([base, payloadExtra])
    full.writeUInt32LE(base.length - 24 + payloadExtra.length, 4) // dataSize aggiornato
    const h = parsePluginHeader(full)!
    expect(h).not.toBeNull()
    expect(h.masters).toEqual(['Skyrim.esm'])
  })

  it('null su file non-plugin, header troncato o subrecord tagliato', () => {
    expect(parsePluginHeader(Buffer.from('non un plugin'))).toBeNull()
    expect(parsePluginHeader(buildTes4({ masters: ['Skyrim.esm'] }).subarray(0, 30))).toBeNull()
    const corrupt = buildTes4({ masters: ['Skyrim.esm'] })
    corrupt.writeUInt16LE(60000, 24 + 4) // size HEDR oltre il payload
    expect(parsePluginHeader(corrupt)).toBeNull()
  })
})

describe('readPluginHeader', () => {
  it('legge solo l’header dal file su disco; garbage → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esp-'))
    try {
      const good = join(dir, 'Mod.esp')
      writeFileSync(good, Buffer.concat([buildTes4({ masters: ['Skyrim.esm'] }), Buffer.alloc(4096, 7)]))
      expect(readPluginHeader(good)?.masters).toEqual(['Skyrim.esm'])
      const bad = join(dir, 'Fake.esp')
      writeFileSync(bad, 'plugin finto dei test')
      expect(readPluginHeader(bad)).toBeNull()
      expect(readPluginHeader(join(dir, 'assente.esp'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isMasterSpace', () => {
  it('estensione .esm/.esl forza lo spazio master; il flag ESM promuove un .esp', () => {
    expect(isMasterSpace('Base.esm', null)).toBe(true)
    expect(isMasterSpace('Light.esl', null)).toBe(true)
    expect(isMasterSpace('Normal.esp', null)).toBe(false)
    expect(isMasterSpace('Promoted.esp', { isEsm: true, isLight: false, masters: [], version: null })).toBe(true)
    // Il solo flag light NON promuove: un .esp light resta nello spazio regular.
    expect(isMasterSpace('LightOnly.esp', { isEsm: false, isLight: true, masters: [], version: null })).toBe(false)
  })
})
