import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseSelectedProfile, parseProfilesDirectory, parseCurrentInstance, resolveMo2Plugins } from './mo2'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mo2-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /**/
    }
  }
})

describe('ini parsers', () => {
  it('parseSelectedProfile reads @ByteArray / plain / quoted', () => {
    expect(parseSelectedProfile('[General]\nselected_profile=@ByteArray(Nolvus)')).toBe('Nolvus')
    expect(parseSelectedProfile('selected_profile=Default')).toBe('Default')
    expect(parseSelectedProfile('selected_profile="My Profile"')).toBe('My Profile')
    expect(parseSelectedProfile('gameName=Skyrim')).toBeNull()
  })
  it('parseProfilesDirectory keeps %BASE_DIR% raw (substituted at resolve time)', () => {
    expect(parseProfilesDirectory('profiles_directory=@ByteArray(%BASE_DIR%/profiles)')).toBe(
      '%BASE_DIR%/profiles',
    )
  })
  it('parseCurrentInstance reads the active MO2 instance', () => {
    expect(parseCurrentInstance('[General]\nCurrentInstance=@ByteArray(Nolvus AE)')).toBe('Nolvus AE')
  })
})

function writeProfile(profilesDir: string, name: string, plugins: string) {
  mkdirSync(join(profilesDir, name), { recursive: true })
  writeFileSync(join(profilesDir, name, 'plugins.txt'), plugins)
}

describe('resolveMo2Plugins — PORTABLE', () => {
  it('reads the active profile next to the exe', () => {
    const base = tmp()
    writeFileSync(join(base, 'ModOrganizer.exe'), 'bin')
    writeFileSync(join(base, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Nolvus)')
    writeProfile(join(base, 'profiles'), 'Nolvus', '# x\n*SkyUI.esp\nOld.esp\n*SKSE.esm')
    const r = resolveMo2Plugins(join(base, 'ModOrganizer.exe'))
    expect(r.profile).toBe('Nolvus')
    expect(r.plugins).toEqual([
      { name: 'SkyUI.esp', enabled: true },
      { name: 'Old.esp', enabled: false },
      { name: 'SKSE.esm', enabled: true },
    ])
  })

  it('honors an ABSOLUTE profiles_directory override', () => {
    const base = tmp()
    const altProfiles = tmp() // absolute external profiles dir
    writeFileSync(join(base, 'ModOrganizer.exe'), 'bin')
    writeFileSync(
      join(base, 'ModOrganizer.ini'),
      `[General]\nselected_profile=Default\nprofiles_directory=@ByteArray(${altProfiles})`,
    )
    writeProfile(altProfiles, 'Default', '*B.esp')
    const r = resolveMo2Plugins(join(base, 'ModOrganizer.exe'))
    expect(r.profile).toBe('Default')
    expect(r.plugins).toEqual([{ name: 'B.esp', enabled: true }])
  })

  it('falls back to the profile whose plugins.txt was modified last', () => {
    const base = tmp()
    writeFileSync(join(base, 'ModOrganizer.exe'), 'bin')
    writeFileSync(join(base, 'ModOrganizer.ini'), '[General]\ngameName=Skyrim')
    writeProfile(join(base, 'profiles'), 'Old', '*A.esp')
    writeProfile(join(base, 'profiles'), 'New', '*B.esp')
    const future = Date.now() / 1000 + 100
    utimesSync(join(base, 'profiles', 'New', 'plugins.txt'), future, future)
    expect(resolveMo2Plugins(join(base, 'ModOrganizer.exe')).profile).toBe('New')
  })
})

describe('resolveMo2Plugins — INSTANCE mode (MO2 default)', () => {
  it('resolves the active instance under LOCALAPPDATA when no portable ini exists', () => {
    const exeDir = tmp() // exe WITHOUT a ModOrganizer.ini next to it
    writeFileSync(join(exeDir, 'ModOrganizer.exe'), 'bin')
    const localAppData = tmp()
    const moRoot = join(localAppData, 'ModOrganizer')
    mkdirSync(moRoot, { recursive: true })
    writeFileSync(join(moRoot, 'ModOrganizer.ini'), '[General]\nCurrentInstance=@ByteArray(Nolvus AE)')
    const inst = join(moRoot, 'Nolvus AE')
    mkdirSync(inst, { recursive: true })
    writeFileSync(join(inst, 'ModOrganizer.ini'), 'selected_profile=Default')
    writeProfile(join(inst, 'profiles'), 'Default', '*SkyUI.esp\n*SKSE.esm')

    const r = resolveMo2Plugins(join(exeDir, 'ModOrganizer.exe'), { localAppData })
    expect(r.profile).toBe('Default')
    expect(r.plugins).toEqual([
      { name: 'SkyUI.esp', enabled: true },
      { name: 'SKSE.esm', enabled: true },
    ])
  })
})

describe('resolveMo2Plugins — fail-safe', () => {
  it('never throws and returns empty on missing/invalid inputs', () => {
    expect(resolveMo2Plugins(null).plugins).toEqual([])
    expect(resolveMo2Plugins('C:/nope/ModOrganizer.exe', { localAppData: null }).plugins).toEqual([])
    const base = tmp()
    writeFileSync(join(base, 'ModOrganizer.exe'), 'bin')
    writeFileSync(join(base, 'ModOrganizer.ini'), 'selected_profile=Ghost') // no plugins.txt
    expect(resolveMo2Plugins(join(base, 'ModOrganizer.exe')).plugins).toEqual([])
  })

  it('rejects a path-traversal profile name', () => {
    const base = tmp()
    writeFileSync(join(base, 'ModOrganizer.exe'), 'bin')
    writeFileSync(join(base, 'ModOrganizer.ini'), 'selected_profile=@ByteArray(../../evil)')
    mkdirSync(join(base, 'profiles'), { recursive: true })
    // traversal name rejected → no valid profile → empty (does not read outside profiles)
    expect(resolveMo2Plugins(join(base, 'ModOrganizer.exe')).plugins).toEqual([])
  })
})
