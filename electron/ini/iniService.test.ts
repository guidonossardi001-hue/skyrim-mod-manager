import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyIniSettings, mergeIniMaps, type IniTemplate, type IniFileMap } from './iniService'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smm-ini-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tpl = (settings: IniFileMap, base?: IniFileMap): IniTemplate => ({ name: 'T', base, settings })
const read = (file: string) => readFileSync(join(dir, file), 'utf8')
const write = (file: string, content: string) => writeFileSync(join(dir, file), content)
/** line index of the first line satisfying pred, or -1 */
const lineOf = (text: string, pred: (l: string) => boolean) =>
  text.split(/\r?\n/).findIndex(pred)

const EXISTING = [
  '; ── user tuned config, DO NOT WIPE ──',
  '[General]',
  'sLanguage=ENGLISH',
  'uGridsToLoad=5   ; keep at 5, higher crashes',
  '',
  '[Display]',
  'iSize W=2560',
  'iSize H=1440',
  'fMyCustomTweak=9.9',
  '',
].join('\r\n')

describe('applyIniSettings — structure & comment preservation', () => {
  it('keeps comments, blank lines, and unmanaged keys byte-for-byte', async () => {
    write('Skyrim.ini', EXISTING)
    await applyIniSettings(dir, tpl({ 'Skyrim.ini': { Display: { iShadowMapResolution: 4096 } } }), {})
    const out = read('Skyrim.ini')

    // standalone comment header survives
    expect(out).toContain('; ── user tuned config, DO NOT WIPE ──')
    // inline comment on an untouched key survives
    expect(out).toContain('uGridsToLoad=5   ; keep at 5, higher crashes')
    // user-only keys are untouched
    expect(out).toContain('iSize W=2560')
    expect(out).toContain('fMyCustomTweak=9.9')
    // blank-line structure preserved (still CRLF, still has the separator)
    expect(out).toContain('\r\n')
    expect(out.split(/\r?\n/).filter((l) => l === '').length).toBeGreaterThanOrEqual(1)
  })

  it('injects a mod-required override into the CORRECT section ([Display], not [General])', async () => {
    write('Skyrim.ini', EXISTING)
    await applyIniSettings(dir, tpl({}), { 'Skyrim.ini': { Display: { iShadowMapResolution: 4096 } } })
    const out = read('Skyrim.ini')

    const display = lineOf(out, (l) => l.trim() === '[Display]')
    const general = lineOf(out, (l) => l.trim() === '[General]')
    const injected = lineOf(out, (l) => l.startsWith('iShadowMapResolution='))
    expect(injected).toBeGreaterThan(display) // it lives under [Display]
    expect(general).toBeLessThan(display) // ...which comes after [General]
    // and it did NOT get dropped into [General]
    expect(injected).toBeGreaterThan(general)
    expect(out).toContain('iShadowMapResolution=4096')
  })

  it('updates an existing key IN PLACE (preserves its inline comment)', async () => {
    write('Skyrim.ini', EXISTING)
    await applyIniSettings(dir, tpl({ 'Skyrim.ini': { General: { uGridsToLoad: 7 } } }), {})
    const out = read('Skyrim.ini')
    expect(out).toContain('uGridsToLoad=7   ; keep at 5, higher crashes')
    expect(out).not.toContain('uGridsToLoad=5')
    // exactly one occurrence — no duplicate appended
    expect(out.split(/\r?\n/).filter((l) => l.startsWith('uGridsToLoad=')).length).toBe(1)
  })

  it('creates a missing section when the key has nowhere to go', async () => {
    write('Skyrim.ini', EXISTING)
    await applyIniSettings(dir, tpl({ 'Skyrim.ini': { Archive: { bInvalidateOlderFiles: 1 } } }), {})
    const out = read('Skyrim.ini')
    expect(out).toContain('[Archive]')
    const arch = lineOf(out, (l) => l.trim() === '[Archive]')
    const key = lineOf(out, (l) => l.startsWith('bInvalidateOlderFiles='))
    expect(key).toBe(arch + 1)
  })
})

describe('applyIniSettings — overlay levels', () => {
  it('seeds the Level-1 base into a brand-new file', async () => {
    const base: IniFileMap = { 'Skyrim.ini': { General: { sLanguage: 'ENGLISH' } } }
    await applyIniSettings(dir, tpl({}, base), {})
    expect(existsSync(join(dir, 'Skyrim.ini'))).toBe(true)
    expect(read('Skyrim.ini')).toContain('sLanguage=ENGLISH')
  })

  it('applies precedence base < template < overrides (later wins)', async () => {
    const base: IniFileMap = { 'Skyrim.ini': { Display: { iShadowMapResolution: 2048 } } }
    const settings: IniFileMap = { 'Skyrim.ini': { Display: { iShadowMapResolution: 4096 } } }
    const overrides: IniFileMap = { 'Skyrim.ini': { Display: { iShadowMapResolution: 1024 } } }
    await applyIniSettings(dir, tpl(settings, base), overrides)
    const out = read('Skyrim.ini')
    expect(out).toContain('iShadowMapResolution=1024') // override won
    expect(out).not.toContain('iShadowMapResolution=2048')
    expect(out).not.toContain('iShadowMapResolution=4096')
  })

  it('does NOT re-seed base over an existing file (user values survive)', async () => {
    write('Skyrim.ini', '[Display]\r\niShadowMapResolution=8192\r\n') // user cranked it
    const base: IniFileMap = { 'Skyrim.ini': { Display: { iShadowMapResolution: 2048 } } }
    await applyIniSettings(dir, tpl({}, base), {}) // base must be ignored for an existing file
    expect(read('Skyrim.ini')).toContain('iShadowMapResolution=8192')
  })

  it('serializes booleans as 1/0 and numbers verbatim', async () => {
    await applyIniSettings(
      dir,
      tpl({ 'SkyrimPrefs.ini': { General: { bPreloadIntroLogos: false, iFoo: 42 } } }),
      {},
    )
    const out = read('SkyrimPrefs.ini')
    expect(out).toContain('bPreloadIntroLogos=0')
    expect(out).toContain('iFoo=42')
  })
})

describe('applyIniSettings — atomic write (crash safety)', () => {
  it('leaves the ORIGINAL file intact when the write fails mid-way', async () => {
    write('Skyrim.ini', EXISTING)
    // Simulate a crash during writing: a directory squats on the temp path, so the
    // writeFile('Skyrim.ini.tmp') step throws (EISDIR) BEFORE any rename touches the real file.
    mkdirSync(join(dir, 'Skyrim.ini.tmp'))

    await expect(
      applyIniSettings(dir, tpl({ 'Skyrim.ini': { Display: { iShadowMapResolution: 4096 } } }), {}),
    ).rejects.toBeTruthy()

    // The real config is byte-for-byte the original — no partial write, no truncation.
    expect(read('Skyrim.ini')).toBe(EXISTING)
    // No stray temp FILE was left as a sibling (the squatting dir is still a dir).
    expect(existsSync(join(dir, 'Skyrim.ini'))).toBe(true)
  })
})

describe('mergeIniMaps', () => {
  it('deep-merges file→section→key with the second map winning', () => {
    const a: IniFileMap = { 'Skyrim.ini': { General: { a: 1, b: 2 }, Archive: { x: 1 } } }
    const b: IniFileMap = { 'Skyrim.ini': { General: { b: 9, c: 3 } }, 'SkyrimPrefs.ini': { UI: { z: 1 } } }
    expect(mergeIniMaps(a, b)).toEqual({
      'Skyrim.ini': { General: { a: 1, b: 9, c: 3 }, Archive: { x: 1 } },
      'SkyrimPrefs.ini': { UI: { z: 1 } },
    })
  })

  it('returns the first map unchanged when the second is undefined', () => {
    const a: IniFileMap = { 'Skyrim.ini': { General: { a: 1 } } }
    expect(mergeIniMaps(a)).toBe(a)
  })
})
