import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectCreationClub, ccFiles, ccPluginOrder } from './ccHandler'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'smm-cc-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const touch = (name: string, content = '') => writeFileSync(join(dataDir, name), content)

describe('detectCreationClub', () => {
  it('detects CC esm/esl/bsa, groups by base name, records the plugin + type', () => {
    touch('ccBGSSSE001-Fish.esm')
    touch('ccBGSSSE001-Fish.bsa')
    touch('ccQDRSSE001-SurvivalMode.esl')
    touch('_ResourcePack.esl')
    touch('_ResourcePack.bsa')

    const pkgs = detectCreationClub(dataDir)
    const fish = pkgs.find((p) => p.name === 'ccBGSSSE001-Fish')
    expect(fish?.plugin).toBe('ccBGSSSE001-Fish.esm')
    expect(fish?.pluginType).toBe('ESM')
    expect(fish?.files.map((f) => f.rel).sort()).toEqual(['ccBGSSSE001-Fish.bsa', 'ccBGSSSE001-Fish.esm'])

    const survival = pkgs.find((p) => p.name === 'ccQDRSSE001-SurvivalMode')
    expect(survival?.pluginType).toBe('ESL')

    const rp = pkgs.find((p) => p.name === '_ResourcePack')
    expect(rp?.plugin).toBe('_ResourcePack.esl')
    expect(rp?.files).toHaveLength(2)
  })

  it('ignores vanilla base masters and ordinary mod files (only CC content)', () => {
    touch('Skyrim.esm')
    touch('Update.esm')
    touch('Dawnguard.esm')
    touch('SomeMod.esp')
    touch('RandomTexturePack.bsa')
    touch('ccBGSSSE001-Fish.esm')

    const pkgs = detectCreationClub(dataDir)
    expect(pkgs.map((p) => p.name)).toEqual(['ccBGSSSE001-Fish'])
  })

  it('orders packages by Skyrim.ccc load order when present', () => {
    touch('ccBGSSSE002-Zombie.esm')
    touch('ccBGSSSE001-Fish.esm')
    touch('ccQDRSSE001-SurvivalMode.esl')
    // ccc lists Fish BEFORE Zombie (reverse of alphabetical) — the manifest must win.
    writeFileSync(
      join(dataDir, 'Skyrim.ccc'),
      ['ccBGSSSE001-Fish.esm', 'ccBGSSSE002-Zombie.esm', 'ccQDRSSE001-SurvivalMode.esl'].join('\r\n'),
    )
    expect(ccPluginOrder(detectCreationClub(dataDir))).toEqual([
      'ccBGSSSE001-Fish.esm',
      'ccBGSSSE002-Zombie.esm',
      'ccQDRSSE001-SurvivalMode.esl',
    ])
  })

  it('falls back to alphabetical order when there is no Skyrim.ccc', () => {
    touch('ccBBBSSE001-B.esm')
    touch('ccAAASSE001-A.esm')
    expect(ccPluginOrder(detectCreationClub(dataDir))).toEqual(['ccAAASSE001-A.esm', 'ccBBBSSE001-B.esm'])
  })

  it('ccFiles flattens every CC file in package order (plugins + archives)', () => {
    touch('ccBGSSSE001-Fish.esm')
    touch('ccBGSSSE001-Fish.bsa')
    const files = ccFiles(detectCreationClub(dataDir))
    expect(files.map((f) => f.rel).sort()).toEqual(['ccBGSSSE001-Fish.bsa', 'ccBGSSSE001-Fish.esm'])
    // sources point at the scanned Data dir (hardlink sources)
    expect(files.every((f) => f.src.includes('smm-cc-'))).toBe(true)
  })
})

describe('detectCreationClub — graceful degradation', () => {
  it('returns [] for a legacy game Data with no CC content', () => {
    touch('Skyrim.esm')
    expect(detectCreationClub(dataDir)).toEqual([])
  })

  it('returns [] for a missing or undefined Data directory (never throws)', () => {
    expect(detectCreationClub(join(dataDir, 'does-not-exist'))).toEqual([])
    expect(detectCreationClub(undefined)).toEqual([])
    expect(detectCreationClub('')).toEqual([])
  })
})
