import { describe, it, expect } from 'vitest'
import {
  scanPluginRecords,
  classifyForEsl,
  pickToFlag,
  setLightFlag,
  lightFlagBytes,
  TES4_FLAGS_OFFSET,
  type EslCandidate,
} from './eslify'
import { buildPlugin, buildGrup, buildRecord } from './tes4Fixture'

// FormID: byte alto = master index. Con 2 master (Skyrim.esm, Update.esm):
// index 0/1 = override, index 2 = spazio PROPRIO (record nuovo).
const M2 = { masters: ['Skyrim.esm', 'Update.esm'] }
const override = (id: number) => buildRecord('WEAP', 0x00_000000 + id) // index 0
const override2 = (id: number) => buildRecord('ARMO', 0x01_000000 + id) // index 1
const own = (id: number) => buildRecord('WEAP', 0x02_000000 + id) // index 2 = proprio

describe('scanPluginRecords', () => {
  it('pure override: zero record propri, parse completo', () => {
    const buf = buildPlugin(M2, [buildGrup('WEAP', [override(1), override(2)]), buildGrup('ARMO', [override2(3)])])
    const s = scanPluginRecords(buf)
    expect(s.parsed).toBe(true)
    expect(s.masterCount).toBe(2)
    expect(s.totalRecords).toBe(3)
    expect(s.ownRecords).toBe(0)
  })

  it('record nel proprio spazio → ownRecords > 0', () => {
    const buf = buildPlugin(M2, [buildGrup('WEAP', [override(1), own(2)])])
    const s = scanPluginRecords(buf)
    expect(s.parsed).toBe(true)
    expect(s.ownRecords).toBe(1)
  })

  it('GRUP annidati: la scansione lineare li attraversa', () => {
    const inner = buildGrup('CELL', [override(9)])
    const buf = buildPlugin(M2, [buildGrup('WRLD', [override(1), inner])])
    const s = scanPluginRecords(buf)
    expect(s.parsed).toBe(true)
    expect(s.totalRecords).toBe(2)
    expect(s.ownRecords).toBe(0)
  })

  it('file troncato o disallineato → parsed:false', () => {
    const good = buildPlugin(M2, [buildGrup('WEAP', [override(1)])])
    expect(scanPluginRecords(good.subarray(0, good.length - 3)).parsed).toBe(false)
    const garbage = Buffer.concat([good, Buffer.from('junk')])
    expect(scanPluginRecords(garbage).parsed).toBe(false)
    expect(scanPluginRecords(Buffer.from('NOPE')).parsed).toBe(false)
  })

  it('flag ESM/light letti dal TES4', () => {
    expect(scanPluginRecords(buildPlugin({ ...M2, esm: true }, [])).isEsm).toBe(true)
    expect(scanPluginRecords(buildPlugin({ ...M2, light: true }, [])).isLight).toBe(true)
  })
})

describe('classifyForEsl', () => {
  const pure = buildPlugin(M2, [buildGrup('WEAP', [override(1)])])

  it('pure override .esp → eleggibile', () => {
    const c = classifyForEsl('Patch.esp', pure)
    expect(c.eligible).toBe(true)
    expect(c.totalRecords).toBe(1)
  })

  it('esclusi: non-.esp, già light, ESM-flagged, record nuovi, parse anomalo', () => {
    expect(classifyForEsl('Master.esm', pure).eligible).toBe(false)
    expect(classifyForEsl('Light.esp', buildPlugin({ ...M2, light: true }, [])).eligible).toBe(false)
    expect(classifyForEsl('EsmFlag.esp', buildPlugin({ ...M2, esm: true }, [])).eligible).toBe(false)
    const withOwn = buildPlugin(M2, [buildGrup('WEAP', [own(1)])])
    const c = classifyForEsl('New.esp', withOwn)
    expect(c.eligible).toBe(false)
    expect(c.reason).toMatch(/record nuovi/)
    expect(classifyForEsl('Broken.esp', Buffer.from('xxxx')).eligible).toBe(false)
  })
})

describe('pickToFlag', () => {
  const cand = (name: string, size: number, eligible = true): EslCandidate => ({
    name,
    src: `C:/mods/${name}`,
    size,
    eligible,
    reason: '',
  })

  it('prende i più piccoli, solo eleggibili, esattamente slotsToFree', () => {
    const picked = pickToFlag([cand('big.esp', 9000), cand('small.esp', 10), cand('no.esp', 1, false), cand('mid.esp', 500)], 2)
    expect(picked.map((p) => p.name)).toEqual(['small.esp', 'mid.esp'])
  })

  it('slotsToFree <= 0 → nessuno', () => {
    expect(pickToFlag([cand('a.esp', 1)], 0)).toEqual([])
  })
})

describe('setLightFlag / lightFlagBytes', () => {
  it('accende SOLO il bit 0x200 nei flags a offset 8', () => {
    const buf = buildPlugin(M2, [])
    const before = buf.readUInt32LE(TES4_FLAGS_OFFSET)
    setLightFlag(buf)
    expect(buf.readUInt32LE(TES4_FLAGS_OFFSET)).toBe(before | 0x200)
    expect(scanPluginRecords(buf).isLight).toBe(true)
    expect(lightFlagBytes(0x1).readUInt32LE(0)).toBe(0x201)
  })
})
