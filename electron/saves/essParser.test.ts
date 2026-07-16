import { describe, it, expect } from 'vitest'
import { deflateSync } from 'zlib'
import { parseEss } from './essParser'

// Costruttore di .ess sintetici — stesso layout dei salvataggi Skyrim SE reali.

function wstr(s: string): Buffer {
  const b = Buffer.from(s, 'latin1')
  const len = Buffer.alloc(2)
  len.writeUInt16LE(b.length)
  return Buffer.concat([len, b])
}
function u8(v: number): Buffer {
  return Buffer.from([v])
}
function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v)
  return b
}

/** Encoder LZ4 solo-literals (blocco valido: unica sequenza finale). */
function lz4Literals(data: Buffer): Buffer {
  if (data.length < 15) return Buffer.concat([u8(data.length << 4), data])
  const ext: number[] = []
  let rem = data.length - 15
  while (rem >= 255) {
    ext.push(255)
    rem -= 255
  }
  ext.push(rem)
  return Buffer.concat([Buffer.from([0xf0, ...ext]), data])
}

interface EssOpts {
  compression?: 0 | 1 | 2
  plugins?: string[]
  lightPlugins?: string[]
  formVersion?: number
  gameVersionString?: string // variante AE recente: wstring tra formVersion e pluginInfo
  corruptMagic?: boolean
}

function buildEss(opts: EssOpts = {}): Buffer {
  const plugins = opts.plugins ?? ['Skyrim.esm', 'Update.esm', 'CoolMod.esp']
  const light = opts.lightPlugins ?? []
  const formVersion = opts.formVersion ?? (light.length ? 78 : 74)
  const compression = opts.compression ?? 2

  const pluginBlock = Buffer.concat([u8(plugins.length), ...plugins.map(wstr)])
  const lightBlock = formVersion >= 78 ? Buffer.concat([u16(light.length), ...light.map(wstr)]) : Buffer.alloc(0)
  const body = Buffer.concat([
    u8(formVersion),
    ...(opts.gameVersionString ? [wstr(opts.gameVersionString)] : []),
    u32(pluginBlock.length + lightBlock.length),
    pluginBlock,
    lightBlock,
    Buffer.from('resto del save non parsato', 'latin1'),
  ])

  const header = Buffer.concat([
    u32(12), // version SE
    u32(42), // saveNumber
    wstr('Dovahkiin'),
    u32(30), // level
    wstr('Whiterun'),
    wstr('10 giorni'),
    wstr('NordRace'),
    u16(0),
    Buffer.alloc(8), // exp f32×2
    Buffer.alloc(8), // filetime
    u32(2), // shotW
    u32(1), // shotH
    u16(compression),
  ])

  const compressed =
    compression === 2 ? lz4Literals(body) : compression === 1 ? deflateSync(body) : body

  return Buffer.concat([
    Buffer.from(opts.corruptMagic ? 'XXXX_SAVEGAME' : 'TESV_SAVEGAME', 'latin1'),
    u32(header.length),
    header,
    Buffer.alloc(2 * 1 * 4), // screenshot RGBA 2×1
    u32(body.length),
    u32(compressed.length),
    compressed,
  ])
}

describe('parseEss', () => {
  it('parse completo di un save LZ4 (il default di SE)', () => {
    const info = parseEss(buildEss())
    expect(info).toMatchObject({
      saveNumber: 42,
      playerName: 'Dovahkiin',
      playerLevel: 30,
      playerLocation: 'Whiterun',
      plugins: ['Skyrim.esm', 'Update.esm', 'CoolMod.esp'],
      lightPlugins: [],
    })
  })

  it('save zlib (uiCompression=1) e non compresso (0)', () => {
    expect(parseEss(buildEss({ compression: 1 }))?.plugins).toContain('CoolMod.esp')
    expect(parseEss(buildEss({ compression: 0 }))?.plugins).toContain('CoolMod.esp')
  })

  it('light plugins letti quando formVersion ≥ 78', () => {
    const info = parseEss(buildEss({ lightPlugins: ['Tiny.esl', 'Small.esl'] }))
    expect(info?.lightPlugins).toEqual(['Tiny.esl', 'Small.esl'])
  })

  it('variante AE recente: wstring versione gioco tra formVersion e pluginInfo', () => {
    const info = parseEss(buildEss({ gameVersionString: '1.6.1170' }))
    expect(info?.plugins).toEqual(['Skyrim.esm', 'Update.esm', 'CoolMod.esp'])
  })

  it('magic sbagliato / file troncato / spazzatura → null, mai throw', () => {
    expect(parseEss(buildEss({ corruptMagic: true }))).toBeNull()
    expect(parseEss(buildEss().subarray(0, 60))).toBeNull()
    expect(parseEss(Buffer.alloc(0))).toBeNull()
    expect(parseEss(Buffer.alloc(4096, 0x99))).toBeNull()
  })

  it('body corrotto (nomi plugin non plausibili) → null', () => {
    const good = buildEss({ compression: 0 })
    // Azzera il corpo DOPO header+screenshot+lunghezze: i nomi plugin diventano garbage.
    const headerSize = good.readUInt32LE(13)
    const bodyStart = 13 + 4 + headerSize + 8 + 8
    const bad = Buffer.from(good)
    bad.fill(0x01, bodyStart + 1)
    expect(parseEss(bad)).toBeNull()
  })
})
