import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  TOOL_SOURCES,
  releaseApiUrl,
  parseRelease,
  pickReleaseAsset,
  findToolExe,
  provisionTool,
  type ProvisionDeps,
  type ToolSource,
} from './provision'

const LOOT = TOOL_SOURCES.find((s) => s.key === 'loot')!
const SSEEDIT = TOOL_SOURCES.find((s) => s.key === 'sseedit')!
const XLODGEN = TOOL_SOURCES.find((s) => s.key === 'xlodgen')!

function release(assets: { name: string; url: string }[], tag = 'v1.0'): unknown {
  return { tag_name: tag, assets: assets.map((a) => ({ name: a.name, browser_download_url: a.url })) }
}

describe('parseRelease', () => {
  it('forma valida → release; spazzatura → null', () => {
    expect(parseRelease(release([{ name: 'a.7z', url: 'https://github.com/x' }]))?.tag_name).toBe('v1.0')
    expect(parseRelease(null)).toBeNull()
    expect(parseRelease({ tag_name: 1, assets: [] })).toBeNull()
    expect(parseRelease({ tag_name: 'v1', assets: 'no' })).toBeNull()
  })
  it('asset malformati filtrati via', () => {
    const r = parseRelease({ tag_name: 'v1', assets: [{ name: 'ok.7z', browser_download_url: 'u' }, { name: 42 }] })
    expect(r?.assets).toHaveLength(1)
  })
})

describe('pickReleaseAsset', () => {
  it('LOOT: sceglie il 7z win64 e ignora l’installer exe', () => {
    const r = parseRelease(
      release([
        { name: 'loot_0.29.1-win64.exe', url: 'https://github.com/loot/loot/releases/download/0.29.1/loot_0.29.1-win64.exe' },
        { name: 'loot_0.29.1-win64.7z', url: 'https://github.com/loot/loot/releases/download/0.29.1/loot_0.29.1-win64.7z' },
      ]),
    )!
    expect(pickReleaseAsset(r, LOOT)?.name).toBe('loot_0.29.1-win64.7z')
  })
  it('xEdit e xLODGen: pattern reali delle release correnti', () => {
    const xe = parseRelease(release([{ name: 'xEdit.4.1.5f.7z', url: 'https://github.com/TES5Edit/TES5Edit/releases/d/x.7z' }]))!
    expect(pickReleaseAsset(xe, SSEEDIT)?.name).toBe('xEdit.4.1.5f.7z')
    const xl = parseRelease(release([{ name: 'xLODGen.132.7z', url: 'https://github.com/sheson/xLODGen/releases/d/x.7z' }]))!
    expect(pickReleaseAsset(xl, XLODGEN)?.name).toBe('xLODGen.132.7z')
  })
  it('RIFIUTA asset che puntano fuori dal repo ufficiale (anti-tamper)', () => {
    const r = parseRelease(release([{ name: 'loot_0.29.1-win64.7z', url: 'https://evil.example.com/loot.7z' }]))!
    expect(pickReleaseAsset(r, LOOT)).toBeNull()
    const r2 = parseRelease(
      release([{ name: 'loot_0.29.1-win64.7z', url: 'https://github.com/attacker/loot/releases/d/loot.7z' }]),
    )!
    expect(pickReleaseAsset(r2, LOOT)).toBeNull()
  })
})

describe('findToolExe', () => {
  it('match case-insensitive, ordine candidati, path meno profondo a parità', () => {
    const files = ['docs\\readme.txt', 'sub\\deep\\xedit64.exe', 'xEdit.exe']
    // xEdit64 preferito a xEdit (ordine candidati) anche se più profondo
    expect(findToolExe(files, SSEEDIT.exeCandidates)).toBe('sub\\deep\\xedit64.exe')
    // a parità di candidato vince il meno profondo
    expect(findToolExe(['a\\LOOT.exe', 'LOOT.exe'], LOOT.exeCandidates)).toBe('LOOT.exe')
    expect(findToolExe(['niente.txt'], LOOT.exeCandidates)).toBeNull()
  })
})

describe('provisionTool', () => {
  const ROOT = 'C:\\ud\\tools'

  function fakeDeps(over: Partial<ProvisionDeps> & { files?: string[] }): ProvisionDeps & {
    downloaded: string[]
    extracted: string[]
    copied: [string, string][]
    removed: string[]
  } {
    const state = { downloaded: [] as string[], extracted: [] as string[], copied: [] as [string, string][], removed: [] as string[] }
    return {
      ...state,
      fetchJson: over.fetchJson ?? (async () => release([{ name: 'loot_0.29.1-win64.7z', url: 'https://github.com/loot/loot/releases/d/loot_0.29.1-win64.7z' }], '0.29.1')),
      downloadFile: over.downloadFile ?? (async (_u, p) => void state.downloaded.push(p)),
      extract: over.extract ?? (async (_a, d) => void state.extracted.push(d)),
      listFilesRel: over.listFilesRel ?? (() => over.files ?? ['LOOT.exe', 'resources\\x.pak']),
      copyFile: (f, t) => void state.copied.push([f, t]),
      mkdirp: () => {},
      rmFile: (p) => void state.removed.push(p),
      toolsRoot: ROOT,
    }
  }

  it('happy path LOOT: scarica, estrae, trova exe, pulisce archivio', async () => {
    const deps = fakeDeps({})
    const r = await provisionTool(LOOT, deps)
    expect(r).toMatchObject({ ok: true, key: 'loot', version: '0.29.1' })
    expect(r.exePath).toBe(join(ROOT, 'loot', 'LOOT.exe'))
    expect(deps.downloaded[0]).toBe(join(ROOT, '.dl', 'loot_0.29.1-win64.7z'))
    expect(deps.extracted[0]).toBe(join(ROOT, 'loot'))
    expect(deps.removed[0]).toBe(join(ROOT, '.dl', 'loot_0.29.1-win64.7z'))
  })

  it('xEdit: crea l’alias SSEEdit64.exe accanto all’exe trovato', async () => {
    const deps = fakeDeps({
      fetchJson: async () => release([{ name: 'xEdit.4.1.5f.7z', url: 'https://github.com/TES5Edit/TES5Edit/releases/d/x.7z' }], '4.1.5f'),
      files: ['xEdit64.exe', 'xEdit.exe'],
    })
    const r = await provisionTool(SSEEDIT, deps)
    expect(r.ok).toBe(true)
    expect(r.exePath).toBe(join(ROOT, 'sseedit', 'SSEEdit64.exe'))
    expect(deps.copied[0]).toEqual([join(ROOT, 'sseedit', 'xEdit64.exe'), join(ROOT, 'sseedit', 'SSEEdit64.exe')])
  })

  it('xEdit release recenti (4.1.5x): riconosce xTESEdit64.exe (layout REALE verificato)', async () => {
    const deps = fakeDeps({
      fetchJson: async () => release([{ name: 'xEdit.4.1.5f.7z', url: 'https://github.com/TES5Edit/TES5Edit/releases/d/x.7z' }], '4.1.5f'),
      files: ['xTESEdit64.exe', 'xTESEdit.exe', 'BSArch64.exe', 'xDump64.exe'],
    })
    const r = await provisionTool(SSEEDIT, deps)
    expect(r.ok).toBe(true)
    expect(r.exePath).toBe(join(ROOT, 'sseedit', 'SSEEdit64.exe'))
    expect(deps.copied[0]).toEqual([join(ROOT, 'sseedit', 'xTESEdit64.exe'), join(ROOT, 'sseedit', 'SSEEdit64.exe')])
  })

  it('release senza asset compatibile → errore pulito', async () => {
    const deps = fakeDeps({ fetchJson: async () => release([{ name: 'sorgenti.tar.gz', url: 'https://github.com/loot/loot/releases/d/s.tar.gz' }]) })
    const r = await provisionTool(LOOT, deps)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/nessun asset/)
  })

  it('download che lancia → no-throw, errore riportato', async () => {
    const deps = fakeDeps({
      downloadFile: async () => {
        throw new Error('ETIMEDOUT')
      },
    })
    const r = await provisionTool(LOOT, deps)
    expect(r).toMatchObject({ ok: false, error: 'ETIMEDOUT' })
  })

  it('exe assente dopo estrazione → errore, archivio comunque rimosso', async () => {
    const deps = fakeDeps({ files: ['solo_docs.txt'] })
    const r = await provisionTool(LOOT, deps)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/eseguibile non trovato/)
    expect(deps.removed).toHaveLength(1)
  })

  it('releaseApiUrl fissa su api.github.com coi soli owner/repo costanti', () => {
    for (const s of TOOL_SOURCES) {
      expect(releaseApiUrl(s)).toBe(`https://api.github.com/repos/${s.owner}/${s.repo}/releases/latest`)
    }
  })

  it('fetchJson che lancia → no-throw', async () => {
    const deps = fakeDeps({
      fetchJson: async () => {
        throw new Error('rete giù')
      },
    })
    expect((await provisionTool(LOOT, deps)).ok).toBe(false)
  })

  it('ogni sorgente dichiarata è coerente (setting key + candidati exe non vuoti)', () => {
    for (const s of TOOL_SOURCES as ToolSource[]) {
      expect(s.exeCandidates.length).toBeGreaterThan(0)
      expect(s.settingKey.endsWith('Path')).toBe(true)
    }
  })
})
