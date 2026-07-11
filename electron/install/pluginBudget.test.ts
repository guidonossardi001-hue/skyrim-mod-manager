import { describe, it, expect } from 'vitest'
import {
  parseTes4Flags,
  isLightFlagged,
  classifyPlugin,
  computePluginBudget,
  FULL_PLUGIN_LIMIT,
} from './pluginBudget'

// Build a minimal TES4 record header: 'TES4' + 4-byte dataSize + 4-byte flags (LE).
function tes4(flags: number): Uint8Array {
  const b = new Uint8Array(12)
  b.set([0x54, 0x45, 0x53, 0x34], 0) // 'TES4'
  b[8] = flags & 0xff
  b[9] = (flags >> 8) & 0xff
  b[10] = (flags >> 16) & 0xff
  b[11] = (flags >> 24) & 0xff
  return b
}

describe('parseTes4Flags', () => {
  it('reads the flags dword from a valid TES4 header', () => {
    expect(parseTes4Flags(tes4(0x0200))).toBe(0x0200)
    expect(parseTes4Flags(tes4(0x0001))).toBe(0x0001)
    expect(parseTes4Flags(tes4(0))).toBe(0)
  })
  it('returns null for non-TES4 / too-short buffers', () => {
    expect(parseTes4Flags(new Uint8Array([0x47, 0x52, 0x55, 0x50, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull() // 'GRUP'
    expect(parseTes4Flags(new Uint8Array(4))).toBeNull()
    expect(parseTes4Flags(null)).toBeNull()
  })
})

describe('isLightFlagged', () => {
  it('detects the 0x200 light flag', () => {
    expect(isLightFlagged(tes4(0x0200))).toBe(true)
    expect(isLightFlagged(tes4(0x0201))).toBe(true) // master + light
    expect(isLightFlagged(tes4(0x0001))).toBe(false) // master only
    expect(isLightFlagged(tes4(0))).toBe(false)
  })
})

describe('classifyPlugin', () => {
  it('.esl is always light (free), regardless of header', () => {
    expect(classifyPlugin('MyMod.esl')).toBe('light')
    expect(classifyPlugin('MyMod.ESL', tes4(0))).toBe('light')
  })
  it('a light-FLAGGED .esp/.esm is light', () => {
    expect(classifyPlugin('Flagged.esp', tes4(0x0200))).toBe('light')
    expect(classifyPlugin('FlaggedMaster.esm', tes4(0x0201))).toBe('light')
  })
  it('a plain .esp/.esm counts as FULL', () => {
    expect(classifyPlugin('Normal.esp', tes4(0))).toBe('full')
    expect(classifyPlugin('Master.esm', tes4(0x0001))).toBe('full')
    expect(classifyPlugin('NoHeader.esp')).toBe('full') // conservative: no header → counts
  })
  it('non-plugin files are other', () => {
    expect(classifyPlugin('textures.bsa')).toBe('other')
    expect(classifyPlugin('readme.txt')).toBe('other')
  })
})

describe('computePluginBudget', () => {
  it('counts FULL against the limit, ignores light', () => {
    const b = computePluginBudget([
      { name: 'a.esp', kind: 'full' },
      { name: 'b.esm', kind: 'full' },
      { name: 'c.esl', kind: 'light' },
      { name: 'd.esp', kind: 'light' },
      { name: 'e.bsa', kind: 'other' },
    ])
    expect(b.full).toBe(2)
    expect(b.light).toBe(2)
    expect(b.total).toBe(4)
    expect(b.overBudget).toBe(false)
    expect(b.remaining).toBe(FULL_PLUGIN_LIMIT - 2)
  })

  it('flags overBudget when FULL exceeds the 254 limit (light never counts)', () => {
    const full = Array.from({ length: 255 }, (_, i) => ({ name: `m${i}.esp`, kind: 'full' as const }))
    const light = Array.from({ length: 500 }, (_, i) => ({ name: `l${i}.esl`, kind: 'light' as const }))
    const b = computePluginBudget([...full, ...light])
    expect(b.full).toBe(255)
    expect(b.overBudget).toBe(true)
    expect(b.remaining).toBe(-1)
    // 500 light plugins do NOT push it over on their own
    expect(computePluginBudget(light).overBudget).toBe(false)
  })
})
