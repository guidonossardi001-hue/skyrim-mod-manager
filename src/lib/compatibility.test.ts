import { describe, it, expect } from 'vitest'
import {
  analyzeModlist,
  classifyPlugin,
  parsePluginsTxt,
  parseLoadOrderTxt,
  type CompatMod,
} from './compatibility'

const mod = (over: Partial<CompatMod>): CompatMod => ({
  name: 'M',
  version: '1.0',
  requires: '[]',
  is_enabled: 1,
  category: 'other',
  nexus_id: null,
  ...over,
})

describe('classifyPlugin', () => {
  it('classifies by extension', () => {
    expect(classifyPlugin('A.esm')).toBe('ESM')
    expect(classifyPlugin('B.esp')).toBe('ESP')
    expect(classifyPlugin('C.esl')).toBe('ESL')
    expect(classifyPlugin('readme.txt')).toBe('unknown')
  })
})

describe('parsePluginsTxt / parseLoadOrderTxt', () => {
  it('parses active (*) vs inactive and comments', () => {
    const r = parsePluginsTxt('# header\n*SkyUI.esp\nOld.esp\n*SKSE.esm')
    expect(r).toEqual([
      { name: 'SkyUI.esp', enabled: true },
      { name: 'Old.esp', enabled: false },
      { name: 'SKSE.esm', enabled: true },
    ])
  })
  it('parses load order list', () => {
    expect(parseLoadOrderTxt('Skyrim.esm\n\nSkyUI.esp\n')).toEqual(['Skyrim.esm', 'SkyUI.esp'])
  })
})

describe('analyzeModlist', () => {
  it('flags a missing dependency as error', () => {
    const r = analyzeModlist({ mods: [mod({ name: 'SkyUI', requires: JSON.stringify(['SKSE64']) })] })
    expect(r.findings.some((f) => f.id.startsWith('missing-dep') && f.severity === 'error')).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('warns when SKSE / Address Library are absent', () => {
    const r = analyzeModlist({ mods: [mod({ name: 'SkyUI' })] })
    expect(r.findings.some((f) => f.id === 'skse')).toBe(true)
  })

  it('is clean with SKSE + Address Library present', () => {
    const r = analyzeModlist({ mods: [mod({ name: 'SKSE64' }), mod({ name: 'Address Library for SKSE' })] })
    expect(r.findings.some((f) => f.id === 'skse')).toBe(false)
    expect(r.findings.some((f) => f.id === 'addrlib')).toBe(false)
  })

  it('detects version drift via latestVersions', () => {
    const r = analyzeModlist({
      mods: [mod({ name: 'SkyUI', nexus_id: 1137, version: '5.2' })],
      latestVersions: { 1137: '5.3' },
    })
    expect(r.findings.some((f) => f.id === 'outdated:1137' && f.severity === 'warning')).toBe(true)
  })

  it('errors over the 254 ESP/ESM load-order limit (ESL excluded)', () => {
    const plugins = Array.from({ length: 260 }, (_, i) => ({ name: `m${i}.esp`, enabled: true }))
    const r = analyzeModlist({ mods: [], plugins })
    expect(r.findings.some((f) => f.id === 'loadorder-limit' && f.severity === 'error')).toBe(true)
    // 300 ESL would NOT trip the limit
    const esl = Array.from({ length: 300 }, (_, i) => ({ name: `e${i}.esl`, enabled: true }))
    expect(analyzeModlist({ mods: [], plugins: esl }).findings.some((f) => f.id === 'loadorder-limit')).toBe(
      false,
    )
  })

  it('advises xEdit cleaning when DLC masters are present', () => {
    const r = analyzeModlist({ mods: [], plugins: [{ name: 'Dawnguard.esm', enabled: true }] })
    expect(r.findings.some((f) => f.id === 'xedit-clean')).toBe(true)
  })
})
