import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  isExecutablePath,
  isRevealKind,
  revealDirForKind,
  allowedRoots,
  validateOpenPath,
  type RevealRoots,
  type RevealProbe,
} from './openTargets'

const UD = 'C:\\Users\\U\\AppData\\Roaming\\smm'
const roots: RevealRoots = {
  backups: join(UD, 'backups'),
  downloads: join(UD, 'downloads'),
  logs: join(UD, 'logs'),
  mods: join(UD, 'mods'),
  stockGame: join(UD, 'StockGame'),
  instances: join(UD, 'instances'),
  game: 'D:\\Steam\\steamapps\\common\\Skyrim Special Edition',
  mo2: 'D:\\MO2',
}

// Probe with no symlinks: realpath is identity, everything "exists".
const idProbe: RevealProbe = { exists: () => true, realpath: (p) => p }

describe('isExecutablePath', () => {
  it('flags executable/script extensions (case-insensitive)', () => {
    for (const p of ['a.exe', 'A.EXE', 'x.bat', 'y.ps1', 'z.lnk', 'w.msi', 'v.vbs', 'u.jar', 't.reg', 's.cmd']) {
      expect(isExecutablePath(p)).toBe(true)
    }
  })
  it('allows data archives and directories', () => {
    for (const p of ['mod.7z', 'mod.zip', 'mod.rar', 'note.txt', join(UD, 'downloads')]) {
      expect(isExecutablePath(p)).toBe(false)
    }
  })
})

describe('isRevealKind / revealDirForKind', () => {
  it('accepts only the fixed kinds', () => {
    expect(isRevealKind('backups')).toBe(true)
    expect(isRevealKind('downloads')).toBe(true)
    expect(isRevealKind('..')).toBe(false)
    expect(isRevealKind('C:\\Windows')).toBe(false)
    expect(isRevealKind(42)).toBe(false)
  })
  it('maps a kind to its directory, null for unknown/unconfigured', () => {
    expect(revealDirForKind('backups', roots)).toBe(roots.backups)
    expect(revealDirForKind('game', roots)).toBe(roots.game)
    expect(revealDirForKind('bogus', roots)).toBeNull()
    expect(revealDirForKind('game', { ...roots, game: null })).toBeNull()
  })
  it('allowedRoots drops the unconfigured (null) roots', () => {
    const r = allowedRoots({ ...roots, game: null, mo2: null })
    expect(r).not.toContain(null)
    expect(r).toContain(roots.backups)
    expect(r.length).toBe(6)
  })
})

describe('validateOpenPath', () => {
  it('accepts a data archive inside the downloads root', () => {
    const p = join(roots.downloads, 'Cool Mod-f123.7z')
    expect(validateOpenPath(p, roots, idProbe)).toEqual({ ok: true, path: p })
  })

  it('accepts a file inside the game root', () => {
    const p = join(roots.game!, 'Data', 'Skyrim.esm')
    expect(validateOpenPath(p, roots, idProbe).ok).toBe(true)
  })

  it('rejects an empty path', () => {
    expect(validateOpenPath('', roots, idProbe)).toMatchObject({ ok: false })
  })

  it('rejects a UNC path (remote payload vector)', () => {
    expect(validateOpenPath('\\\\attacker\\share\\evil.7z', roots, idProbe)).toMatchObject({ ok: false })
  })

  it('rejects an executable even inside an authorized root', () => {
    const p = join(roots.mods, 'SomeMod', 'installer.exe')
    const d = validateOpenPath(p, roots, idProbe)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain('eseguibile')
  })

  it('rejects a path outside every authorized root', () => {
    expect(validateOpenPath('C:\\Windows\\System32\\calc.exe', roots, idProbe)).toMatchObject({ ok: false })
    expect(validateOpenPath('C:\\Windows\\System32', roots, idProbe)).toMatchObject({ ok: false })
  })

  it('rejects a ../ traversal that escapes the roots', () => {
    const p = join(roots.downloads, '..', '..', '..', 'secret.7z')
    expect(validateOpenPath(p, roots, idProbe)).toMatchObject({ ok: false })
  })

  it('rejects a junction/symlink whose REAL target escapes the root', () => {
    // A file that appears under downloads/ but whose realpath resolves to C:\Windows.
    const fake = join(roots.downloads, 'link.7z')
    const escaping: RevealProbe = {
      exists: () => true,
      realpath: (p) => (p === fake ? 'C:\\Windows\\System32\\evil.7z' : p),
    }
    expect(validateOpenPath(fake, roots, escaping)).toMatchObject({ ok: false })
  })
})
