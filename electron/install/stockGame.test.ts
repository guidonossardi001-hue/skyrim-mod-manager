import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyRootEntry,
  classifyDataEntry,
  planStockGame,
  createStockGame,
  createStockGameAsync,
  sameVolume,
  defaultStockGameDir,
} from './stockGame'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smm-stockgame-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('stockGame: pure classifiers', () => {
  it('keeps vanilla root files, skips mod/tool files', () => {
    expect(classifyRootEntry('SkyrimSE.exe', false)).toBe('vanilla')
    expect(classifyRootEntry('SkyrimSELauncher.exe', false)).toBe('vanilla')
    expect(classifyRootEntry('steam_api64.dll', false)).toBe('vanilla')
    expect(classifyRootEntry('bink2w64.dll', false)).toBe('vanilla')
    expect(classifyRootEntry('Data', true)).toBe('vanilla')
    expect(classifyRootEntry('_CommonRedist', true)).toBe('vanilla')
    // non-vanilla
    expect(classifyRootEntry('skse64_loader.exe', false)).toBe('skip')
    expect(classifyRootEntry('d3dx9_42.dll', false)).toBe('skip') // ENB
    expect(classifyRootEntry('enbseries', true)).toBe('skip')
    expect(classifyRootEntry('SKSE', true)).toBe('skip')
  })

  it('keeps vanilla/DLC/CC Data files, skips mod content', () => {
    // base + DLC
    expect(classifyDataEntry('Skyrim.esm', false)).toBe('vanilla')
    expect(classifyDataEntry('Update.esm', false)).toBe('vanilla')
    expect(classifyDataEntry('Dawnguard.esm', false)).toBe('vanilla')
    expect(classifyDataEntry('Dragonborn.esm', false)).toBe('vanilla')
    expect(classifyDataEntry('Skyrim - Textures5.bsa', false)).toBe('vanilla')
    expect(classifyDataEntry('Skyrim - Voices_en0.bsa', false)).toBe('vanilla')
    // Creation Club / AE
    expect(classifyDataEntry('ccBGSSSE001-Fish.esm', false)).toBe('vanilla')
    expect(classifyDataEntry('ccBGSSSE001-Fish.bsa', false)).toBe('vanilla')
    expect(classifyDataEntry('_ResourcePack.esl', false)).toBe('vanilla')
    expect(classifyDataEntry('_ResourcePack.bsa', false)).toBe('vanilla')
    expect(classifyDataEntry('Skyrim.ccc', false)).toBe('vanilla')
    // vanilla dirs
    expect(classifyDataEntry('Video', true)).toBe('vanilla')
    expect(classifyDataEntry('Strings', true)).toBe('vanilla')
    // mod content → skip
    expect(classifyDataEntry('SkyUI_SE.esp', false)).toBe('skip')
    expect(classifyDataEntry('Unofficial Skyrim Special Edition Patch.esp', false)).toBe('skip')
    expect(classifyDataEntry('SomeModTextures.bsa', false)).toBe('skip') // not "Skyrim - …"
    expect(classifyDataEntry('textures', true)).toBe('skip') // loose mod assets
    expect(classifyDataEntry('meshes', true)).toBe('skip')
    expect(classifyDataEntry('SKSE', true)).toBe('skip')
    expect(classifyDataEntry('scripts', true)).toBe('skip')
  })
})

describe('stockGame: helpers', () => {
  it('sameVolume compares drive letters on win32', () => {
    if (process.platform === 'win32') {
      expect(sameVolume('C:/librearia steam/x', 'C:/Users/me/StockGame')).toBe(true)
      expect(sameVolume('C:/a', 'D:/b')).toBe(false)
    } else {
      expect(sameVolume('/a', '/b')).toBe(true)
    }
  })
  it('defaultStockGameDir nests under userData', () => {
    expect(defaultStockGameDir(join('U', 'data')).endsWith('StockGame')).toBe(true)
  })
})

// Build a fake game tree: real vanilla files + decoy mod files that MUST be skipped.
function makeFakeGame(root: string) {
  mkdirSync(join(root, 'Data'), { recursive: true })
  mkdirSync(join(root, 'Data', 'Video'), { recursive: true })
  mkdirSync(join(root, 'Data', 'textures', 'armor'), { recursive: true }) // mod content
  mkdirSync(join(root, '_CommonRedist', 'vcredist'), { recursive: true })
  mkdirSync(join(root, 'SKSE'), { recursive: true }) // mod tool

  // vanilla
  writeFileSync(join(root, 'SkyrimSE.exe'), 'EXE')
  writeFileSync(join(root, 'SkyrimSELauncher.exe'), 'LAUNCH')
  writeFileSync(join(root, 'steam_api64.dll'), 'DLL')
  writeFileSync(join(root, 'Data', 'Skyrim.esm'), 'X'.repeat(1000))
  writeFileSync(join(root, 'Data', 'Update.esm'), 'X'.repeat(500))
  writeFileSync(join(root, 'Data', 'Skyrim - Textures0.bsa'), 'X'.repeat(2000))
  writeFileSync(join(root, 'Data', 'ccBGSSSE001-Fish.esm'), 'X'.repeat(10))
  writeFileSync(join(root, 'Data', 'Video', 'BGS_Logo.bik'), 'X'.repeat(50))
  writeFileSync(join(root, '_CommonRedist', 'vcredist', 'vc.exe'), 'X'.repeat(30))

  // mod content (must be skipped)
  writeFileSync(join(root, 'skse64_loader.exe'), 'MOD')
  writeFileSync(join(root, 'd3d11.dll'), 'ENB')
  writeFileSync(join(root, 'Data', 'SkyUI_SE.esp'), 'X'.repeat(9999))
  writeFileSync(join(root, 'Data', 'BigModTextures.bsa'), 'X'.repeat(99999))
  writeFileSync(join(root, 'Data', 'textures', 'armor', 'steel.dds'), 'X'.repeat(99999))
  writeFileSync(join(root, 'SKSE', 'plugin.dll'), 'X'.repeat(123))
}

describe('stockGame: plan', () => {
  it('plans only the vanilla set and counts skipped mod content', () => {
    const src = join(dir, 'game')
    makeFakeGame(src)
    const plan = planStockGame(src)
    const rels = plan.files.map((f) => f.rel).sort()
    expect(rels).toContain('SkyrimSE.exe')
    expect(rels).toContain('Data/Skyrim.esm')
    expect(rels).toContain('Data/Skyrim - Textures0.bsa')
    expect(rels).toContain('Data/ccBGSSSE001-Fish.esm')
    expect(rels).toContain('Data/Video/BGS_Logo.bik')
    expect(rels).toContain('_CommonRedist/vcredist/vc.exe')
    // skipped
    expect(rels).not.toContain('skse64_loader.exe')
    expect(rels).not.toContain('Data/SkyUI_SE.esp')
    expect(rels).not.toContain('Data/BigModTextures.bsa')
    expect(rels.some((r) => r.includes('textures/armor'))).toBe(false)
    expect(plan.skippedFiles).toBeGreaterThan(0)
    expect(plan.skippedBytes).toBeGreaterThan(99999) // the big mod bsa + dds were excluded
  })
})

describe('stockGame: create', () => {
  it('builds an isolated StockGame with only vanilla files and verifies required', () => {
    const src = join(dir, 'game')
    makeFakeGame(src)
    const target = join(dir, 'StockGame')
    const events: string[] = []
    const res = createStockGame({ sourceGameDir: src, targetDir: target, mode: 'copy' }, (p) =>
      events.push(p.phase),
    )

    // required vanilla present, mod content absent
    expect(existsSync(join(target, 'SkyrimSE.exe'))).toBe(true)
    expect(existsSync(join(target, 'Data', 'Skyrim.esm'))).toBe(true)
    expect(existsSync(join(target, 'Data', 'Video', 'BGS_Logo.bik'))).toBe(true)
    expect(existsSync(join(target, 'skse64_loader.exe'))).toBe(false)
    expect(existsSync(join(target, 'Data', 'BigModTextures.bsa'))).toBe(false)
    expect(existsSync(join(target, 'Data', 'textures'))).toBe(false)

    expect(res.missingRequired).toEqual([])
    expect(res.copied).toBeGreaterThan(0)
    expect(res.mode).toBe('copy')
    expect(events).toContain('copying')
    expect(events[events.length - 1]).toBe('done')

    // content integrity of a copied file
    expect(readFileSync(join(target, 'Data', 'Update.esm'), 'utf8')).toBe('X'.repeat(500))
  })

  it('is idempotent on re-run (already-present files are not re-copied)', () => {
    const src = join(dir, 'game')
    makeFakeGame(src)
    const target = join(dir, 'StockGame')
    createStockGame({ sourceGameDir: src, targetDir: target, mode: 'copy' })
    const res2 = createStockGame({ sourceGameDir: src, targetDir: target, mode: 'copy' })
    expect(res2.alreadyPresent).toBe(res2.filesTotal)
    expect(res2.copied).toBe(0)
  })

  it('hardlinks within the same volume (zero extra bytes) when supported', () => {
    const src = join(dir, 'game')
    makeFakeGame(src)
    const target = join(dir, 'StockGame')
    const res = createStockGame({ sourceGameDir: src, targetDir: target, mode: 'hardlink' })
    // tmp src and target share a volume here, so links should be used (or copy fallback on odd FS)
    expect(res.hardlinked + res.copied).toBe(res.filesTotal)
    if (res.mode === 'hardlink') {
      // a hardlink shares the inode → same size, same content
      expect(statSync(join(target, 'Data', 'Skyrim.esm')).size).toBe(1000)
    }
  })

  it('refuses a source that is not a Skyrim install', () => {
    const bogus = join(dir, 'notgame')
    mkdirSync(bogus, { recursive: true })
    expect(() => createStockGame({ sourceGameDir: bogus, targetDir: join(dir, 'sg') })).toThrow(
      /Skyrim SE\/AE valida|non trovata/,
    )
  })

  it('async variant produces the same isolated vanilla result', async () => {
    const src = join(dir, 'game')
    makeFakeGame(src)
    const target = join(dir, 'StockGameA')
    const res = await createStockGameAsync({ sourceGameDir: src, targetDir: target, mode: 'copy' })
    expect(existsSync(join(target, 'Data', 'Skyrim.esm'))).toBe(true)
    expect(existsSync(join(target, 'Data', 'BigModTextures.bsa'))).toBe(false)
    expect(res.missingRequired).toEqual([])
    expect(res.copied).toBe(res.filesTotal)
    await expect(
      createStockGameAsync({ sourceGameDir: join(dir, 'nope'), targetDir: target }),
    ).rejects.toThrow(/non trovata/)
  })
})
