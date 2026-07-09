import { describe, it, expect } from 'vitest'
import { findPandoraExe, detectPandora, pandoraRoots, PANDORA_EXE, type FsProbe } from './pandora'

// Fake fs mirroring the real C:\pandora layout (two engine folders, exe one level deep).
function fakeFs(tree: Record<string, string[] | null>): FsProbe {
  // tree: path -> array of child names (dir) | null (file). Normalised to forward slashes.
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    exists: (p) => norm(p) in tree || Object.keys(tree).some((k) => k === norm(p)),
    isDirectory: (p) => Array.isArray(tree[norm(p)]),
    readdir: (p) => (tree[norm(p)] as string[] | undefined) ?? [],
  }
}

const LAYOUT = {
  'C:/pandora': [
    'Pandora Behaviour Engine Preview',
    'Pandora Behaviour Engine v4.3.1-beta-133232-v4-3-1-beta-1776378314',
  ],
  'C:/pandora/Pandora Behaviour Engine Preview': [
    'FNIS.esp',
    'Nemesis_Engine',
    PANDORA_EXE,
    'Pandora_Engine',
  ],
  'C:/pandora/Pandora Behaviour Engine Preview/Nemesis_Engine': [],
  'C:/pandora/Pandora Behaviour Engine Preview/Pandora_Engine': [],
  'C:/pandora/Pandora Behaviour Engine Preview/FNIS.esp': null,
  [`C:/pandora/Pandora Behaviour Engine Preview/${PANDORA_EXE}`]: null,
  'C:/pandora/Pandora Behaviour Engine v4.3.1-beta-133232-v4-3-1-beta-1776378314': [
    'FNIS.esp',
    'Nemesis_Engine',
    PANDORA_EXE,
    'Pandora_Engine',
  ],
  'C:/pandora/Pandora Behaviour Engine v4.3.1-beta-133232-v4-3-1-beta-1776378314/Nemesis_Engine': [],
  'C:/pandora/Pandora Behaviour Engine v4.3.1-beta-133232-v4-3-1-beta-1776378314/Pandora_Engine': [],
  [`C:/pandora/Pandora Behaviour Engine v4.3.1-beta-133232-v4-3-1-beta-1776378314/${PANDORA_EXE}`]: null,
}

describe('pandora: detection', () => {
  it('finds the exe one level deep and prefers the versioned build over Preview', () => {
    const exe = findPandoraExe(['C:/pandora'], fakeFs(LAYOUT))
    expect(exe).not.toBeNull()
    expect(exe!.replace(/\\/g, '/')).toContain('v4.3.1-beta-133232') // versioned, not Preview
    expect(exe!.endsWith(PANDORA_EXE)).toBe(true)
  })

  it('detectPandora returns folder + exe + flag', () => {
    const d = detectPandora(['C:/pandora'], fakeFs(LAYOUT))
    expect(d.exeFound).toBe(true)
    expect(d.exePath!.endsWith(PANDORA_EXE)).toBe(true)
    expect(d.path!.replace(/\\/g, '/')).toContain('v4.3.1-beta-133232')
    expect(d.candidatesTried).toContain('C:/pandora')
  })

  it('accepts a root that IS the exe directly', () => {
    const exePath = `C:/pandora/x/${PANDORA_EXE}`
    const fs = fakeFs({ [exePath]: null })
    expect(findPandoraExe([exePath], fs)).toBe(exePath)
  })

  it('accepts the engine folder directly (exe in root)', () => {
    const fs = fakeFs({ 'D:/PB': [PANDORA_EXE], [`D:/PB/${PANDORA_EXE}`]: null })
    expect(findPandoraExe(['D:/PB'], fs)!.endsWith(PANDORA_EXE)).toBe(true)
  })

  it('returns null when absent / no exe', () => {
    expect(findPandoraExe(['C:/nope'], fakeFs({}))).toBeNull()
    expect(detectPandora(['C:/empty'], fakeFs({ 'C:/empty': [] })).exeFound).toBe(false)
  })

  it('pandoraRoots puts the saved path first and includes C:/pandora', () => {
    const roots = pandoraRoots('E:/custom/pandora', 'C:/Users/me')
    expect(roots[0]).toBe('E:/custom/pandora')
    expect(roots).toContain('C:/pandora')
    expect(pandoraRoots(null)).toContain('C:/pandora')
  })
})
