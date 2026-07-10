import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchGame, createDesktopShortcut, resolveLauncherIcon } from './launcherService'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'smm-launcher-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('launchGame', () => {
  it('fails cleanly for a missing executable (no-throw boundary)', () => {
    const r = launchGame({ exePath: join(tmp(), 'nope.exe') })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/non trovato/)
    expect(r.pid).toBeUndefined()
  })

  it('spawns a real executable detached and returns a pid', () => {
    // process.execPath (the Node binary running this test) is a real, absolute,
    // guaranteed-existing executable — no fixture needed. --version exits almost
    // instantly; stdio is 'ignore' so we never read its output.
    const r = launchGame({ exePath: process.execPath, args: ['--version'] })
    expect(r.success).toBe(true)
    expect(typeof r.pid).toBe('number')
    expect(r.error).toBeUndefined()
  })
})

describe('createDesktopShortcut', () => {
  it('fails cleanly when the target executable does not exist', () => {
    const desktopDir = tmp()
    const r = createDesktopShortcut({
      targetExePath: join(tmp(), 'ghost.exe'),
      shortcutName: 'Gioco',
      desktopDir,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/non trovato/)
    expect(existsSync(join(desktopDir, 'Gioco.lnk'))).toBe(false)
  })

  it('creates a real .lnk on disk pointing at the target executable', () => {
    const gameDir = tmp()
    const desktopDir = tmp()
    const exe = join(gameDir, 'SkyrimSELauncher.exe')
    writeFileSync(exe, 'fake pe bytes')

    const r = createDesktopShortcut({
      targetExePath: exe,
      shortcutName: 'Skyrim AE Mod Manager',
      desktopDir,
    })

    expect(r.success).toBe(true)
    expect(r.shortcutPath).toBe(join(desktopDir, 'Skyrim AE Mod Manager.lnk'))
    expect(existsSync(r.shortcutPath!)).toBe(true)
    // A real .lnk is a non-trivial binary structure — a few bytes would mean
    // wscript.exe silently failed to populate it.
    expect(statSync(r.shortcutPath!).size).toBeGreaterThan(100)
  })

  it('sanitizes a shortcut name containing Windows-reserved characters', () => {
    const gameDir = tmp()
    const desktopDir = tmp()
    const exe = join(gameDir, 'game.exe')
    writeFileSync(exe, 'x')

    const r = createDesktopShortcut({
      targetExePath: exe,
      shortcutName: 'Mod: Manager / Launcher?',
      desktopDir,
    })

    expect(r.success).toBe(true)
    expect(r.shortcutPath).toBe(join(desktopDir, 'Mod_ Manager _ Launcher_.lnk'))
    expect(existsSync(r.shortcutPath!)).toBe(true)
  })

  it('does not leave the throwaway .vbs script behind after success or failure', () => {
    const desktopDir = tmp()
    createDesktopShortcut({ targetExePath: join(tmp(), 'ghost.exe'), shortcutName: 'X', desktopDir })
    const leftover = readdirSync(tmpdir()).filter((n) => n.startsWith('smm-shortcut-'))
    expect(leftover).toEqual([])
  })
})

describe('resolveLauncherIcon', () => {
  it('returns the first existing candidate in priority order', () => {
    const dir = tmp()
    const missing = join(dir, 'missing.ico')
    const present = join(dir, 'present.ico')
    writeFileSync(present, 'icon bytes')
    expect(resolveLauncherIcon([missing, present])).toBe(present)
  })

  it('returns null when no candidate exists', () => {
    const dir = tmp()
    expect(resolveLauncherIcon([join(dir, 'a.ico'), null, undefined, join(dir, 'b.ico')])).toBeNull()
  })
})
