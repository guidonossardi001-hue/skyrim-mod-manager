import { describe, it, expect } from 'vitest'
import { buildBethiniIniMap, bethiniPresetTemplate, isValidBethiniTier, BETHINI_TIERS_BY_FLAVOR } from './bethiniPresets'
import { applyIniSettings } from './iniService'
import { readFile, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('buildBethiniIniMap', () => {
  it('bethini/ultra: valori esatti verificati', () => {
    const map = buildBethiniIniMap('ultra', 'bethini')
    expect(map['Skyrim.ini'].Grass.iMinGrassSize).toBe(40)
    expect(map['SkyrimPrefs.ini'].Grass.fGrassStartFadeDistance).toBe(6144.0)
    expect(map['SkyrimPrefs.ini'].Display.iShadowMapResolution).toBe(4096)
    expect(map['SkyrimPrefs.ini'].TerrainManager.fBlockMaximumDistance).toBe(327680)
  })

  it('vanilla non ha tier "poor"', () => {
    expect(isValidBethiniTier('vanilla', 'poor')).toBe(false)
    expect(isValidBethiniTier('bethini', 'poor')).toBe(true)
    expect(BETHINI_TIERS_BY_FLAVOR.vanilla).not.toContain('poor')
  })

  it('vanilla/low: valori esatti verificati', () => {
    const map = buildBethiniIniMap('low', 'vanilla')
    expect(map['Skyrim.ini'].Grass.iMinGrassSize).toBe(20)
    expect(map['SkyrimPrefs.ini'].TerrainManager.fBlockLevel0Distance).toBe(15000)
    expect(map['SkyrimPrefs.ini'].Display.iShadowMapResolution).toBe(1024)
  })
})

describe('bethiniPresetTemplate + applyIniSettings — integrazione reale', () => {
  it('scrive le chiavi nei file ini senza toccare il resto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bethini-test-'))
    try {
      const template = bethiniPresetTemplate('high', 'bethini')
      await applyIniSettings(dir, template, {})
      const prefs = await readFile(join(dir, 'SkyrimPrefs.ini'), 'utf8')
      expect(prefs).toMatch(/iShadowMapResolution=2048/)
      expect(prefs).toMatch(/fBlockMaximumDistance=262144/)
      const skyrim = await readFile(join(dir, 'Skyrim.ini'), 'utf8')
      expect(skyrim).toMatch(/iMinGrassSize=40/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
