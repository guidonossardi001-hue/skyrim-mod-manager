import { describe, it, expect } from 'vitest'
import { parseMO2Modlist } from './modlist'

describe('parseMO2Modlist', () => {
  it('parses +/-/* prefixes into enabled flags', () => {
    expect(parseMO2Modlist('+SkyUI\n-Old Mod\n*Separator')).toEqual([
      { name: 'SkyUI', enabled: true },
      { name: 'Old Mod', enabled: false },
      { name: 'Separator', enabled: false },
    ])
  })

  it('skips comments and blank/whitespace lines', () => {
    expect(parseMO2Modlist('# header\n\n   \n+A\n')).toEqual([{ name: 'A', enabled: true }])
  })

  it('trims whitespace around the mod name', () => {
    expect(parseMO2Modlist('+  Spaced Mod  ')).toEqual([{ name: 'Spaced Mod', enabled: true }])
  })

  it('ignores a prefix with no name', () => {
    expect(parseMO2Modlist('+\n-   \nValid')).toEqual([{ name: 'Valid', enabled: false }])
  })

  it('returns an empty array for empty input', () => {
    expect(parseMO2Modlist('')).toEqual([])
  })
})
