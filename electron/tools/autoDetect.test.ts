import { describe, it, expect } from 'vitest'
import { scanForExes, standardToolRoots, detectToolPaths, TOOL_SPECS, type DetectDeps } from './autoDetect'
import type { FsProbe } from './pandora'

// Fake fs: tree maps normalised dir path → children names; files listed as leaf names.
function fakeFs(dirs: Record<string, string[]>, files: Set<string>): FsProbe {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const nfiles = new Set([...files].map(norm))
  return {
    exists: (p) => {
      const n = norm(p)
      return n in dirs || nfiles.has(n)
    },
    readdir: (p) => dirs[norm(p)] ?? [],
    isDirectory: (p) => norm(p) in dirs,
  }
}

describe('autoDetect: scanForExes', () => {
  const dirs: Record<string, string[]> = {
    'C:/Modding': ['MO2', 'Tools', 'Windows'],
    'C:/Modding/MO2': ['ModOrganizer.exe', 'mods'],
    'C:/Modding/MO2/mods': [],
    'C:/Modding/Tools': ['SSEEdit', 'DynDOLOD'],
    'C:/Modding/Tools/SSEEdit': ['SSEEdit.exe'],
    'C:/Modding/Tools/DynDOLOD': ['DynDOLOD Standalone'],
    'C:/Modding/Tools/DynDOLOD/DynDOLOD Standalone': ['DynDOLODx64.exe'],
    'C:/Modding/Windows': ['should_not_descend.exe'], // in SKIP_DIRS → ignored
  }
  const files = new Set([
    'C:/Modding/MO2/ModOrganizer.exe',
    'C:/Modding/Tools/SSEEdit/SSEEdit.exe',
    'C:/Modding/Tools/DynDOLOD/DynDOLOD Standalone/DynDOLODx64.exe',
    'C:/Modding/Windows/should_not_descend.exe',
  ])
  const fs = fakeFs(dirs, files)

  it('finds tools by exe name across bounded depth, first match wins', () => {
    const found = scanForExes(['C:/Modding'], TOOL_SPECS, fs, 4)
    expect(found.mo2?.replace(/\\/g, '/')).toBe('C:/Modding/MO2/ModOrganizer.exe')
    expect(found.sseedit?.replace(/\\/g, '/')).toBe('C:/Modding/Tools/SSEEdit/SSEEdit.exe')
    expect(found.dyndolod?.replace(/\\/g, '/')).toBe(
      'C:/Modding/Tools/DynDOLOD/DynDOLOD Standalone/DynDOLODx64.exe',
    )
    expect(found.loot).toBeUndefined() // LOOT not in tree → silent
    expect(found.xlodgen).toBeUndefined()
  })

  it('respects maxDepth (exe below the cap not found)', () => {
    const shallow = scanForExes(['C:/Modding'], TOOL_SPECS, fs, 0) // only root-level files
    expect(shallow.mo2).toBeUndefined() // ModOrganizer.exe is at depth 1
    const mid = scanForExes(['C:/Modding'], TOOL_SPECS, fs, 2)
    expect(mid.mo2).toBeDefined() // depth 1 → found
    expect(mid.dyndolod).toBeUndefined() // DynDOLODx64.exe is at depth 4 → beyond cap
  })

  it('skips SKIP_DIRS (Windows/etc.)', () => {
    const found = scanForExes(['C:/Modding'], [{ key: 'x', exes: ['should_not_descend.exe'] }], fs, 5)
    expect(found.x).toBeUndefined()
  })

  it('matches case-insensitively and accepts alt exe names', () => {
    const d = { 'D:/T': ['sseeditx64.EXE'] }
    const f = new Set(['D:/T/sseeditx64.EXE'])
    const found = scanForExes(['D:/T'], TOOL_SPECS, fakeFs(d, f), 2)
    expect(found.sseedit?.replace(/\\/g, '/')).toBe('D:/T/sseeditx64.EXE')
  })
})

describe('autoDetect: standardToolRoots', () => {
  it('includes only existing roots, de-duplicated, game-derived first', () => {
    const dirs = { 'C:/Games/Skyrim': [], 'C:/Games': [], 'C:/Modding': [] }
    const deps: DetectDeps = {
      gamePath: 'C:/Games/Skyrim',
      steamLibraries: [],
      sevenZip: null,
      pandora: null,
      fs: fakeFs(dirs, new Set()),
    }
    const roots = standardToolRoots(deps).map((r) => r.replace(/\\/g, '/'))
    expect(roots[0]).toBe('C:/Games/Skyrim')
    expect(roots).toContain('C:/Games') // dirname(gamePath)
    expect(roots).toContain('C:/Modding')
    expect(roots).not.toContain('C:/Tools') // does not exist → excluded
  })
})

describe('autoDetect: detectToolPaths (silent fallback)', () => {
  const dirs: Record<string, string[]> = {
    'C:/Games/Skyrim Special Edition': [],
    'C:/Modding': ['MO2'],
    'C:/Modding/MO2': ['ModOrganizer.exe', 'mods'],
    'C:/Modding/MO2/mods': [],
  }
  const files = new Set(['C:/Modding/MO2/ModOrganizer.exe'])
  const deps: DetectDeps = {
    gamePath: 'C:/Games/Skyrim Special Edition',
    steamLibraries: [],
    sevenZip: 'C:/Program Files/7-Zip/7z.exe',
    pandora: 'C:/pandora/Pandora Behaviour Engine+.exe',
    fs: fakeFs(dirs, files),
  }

  it('populates found tools + derives MO2 mods folder; leaves missing ones unset', () => {
    const p = detectToolPaths(deps)
    expect(p.gamePath).toBe('C:/Games/Skyrim Special Edition')
    expect(p.sevenZipPath).toBe('C:/Program Files/7-Zip/7z.exe')
    expect(p.pandoraPath).toBe('C:/pandora/Pandora Behaviour Engine+.exe')
    expect(p.mo2Path?.replace(/\\/g, '/')).toBe('C:/Modding/MO2/ModOrganizer.exe')
    expect(p.modsPath?.replace(/\\/g, '/')).toBe('C:/Modding/MO2/mods') // derived from MO2 dir
    expect(p.lootPath).toBeUndefined() // silent: not found, not blocking
    expect(p.sseeditPath).toBeUndefined()
    expect(p.dyndolodPath).toBeUndefined()
    expect(p.xlodgenPath).toBeUndefined()
  })

  it('returns an empty-ish map when nothing is found (never throws)', () => {
    const p = detectToolPaths({
      gamePath: null,
      steamLibraries: [],
      sevenZip: null,
      pandora: null,
      fs: fakeFs({}, new Set()),
    })
    expect(Object.keys(p).length).toBe(0)
  })
})
