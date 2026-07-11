import { describe, it, expect } from 'vitest'
import { validateSettingWrite, PATH_SETTING_KEYS } from './settingsGuard'

describe('validateSettingWrite (settings:set value guard, SRB-001)', () => {
  it('lets non-path keys through untouched', () => {
    expect(validateSettingWrite('downloadThreads', 8)).toEqual({ ok: true })
    expect(validateSettingWrite('nexusEnabled', true)).toEqual({ ok: true })
    expect(validateSettingWrite('anythingElse', { a: 1 })).toEqual({ ok: true })
  })

  it('accepts a clear (empty/null) for a path key', () => {
    expect(validateSettingWrite('gamePath', '')).toEqual({ ok: true })
    expect(validateSettingWrite('gamePath', null)).toEqual({ ok: true })
  })

  it('accepts an absolute local path for a path key', () => {
    expect(validateSettingWrite('gamePath', 'C:\\Steam\\Skyrim').ok).toBe(true)
    expect(validateSettingWrite('mo2Path', 'D:\\MO2\\ModOrganizer.exe').ok).toBe(true)
    expect(validateSettingWrite('modsPath', '/home/u/mods').ok).toBe(true)
  })

  it('rejects a UNC path (remote executable vector)', () => {
    const r = validateSettingWrite('gamePath', '\\\\attacker\\share\\evil')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('UNC')
    expect(validateSettingWrite('mo2Path', '//attacker/share').ok).toBe(false)
  })

  it('rejects a non-string value for a path key', () => {
    expect(validateSettingWrite('gamePath', 42).ok).toBe(false)
    expect(validateSettingWrite('gamePath', { toString: () => 'C:\\x' }).ok).toBe(false)
  })

  it('rejects a relative path for a path key', () => {
    expect(validateSettingWrite('gamePath', 'relative\\path').ok).toBe(false)
    expect(validateSettingWrite('sevenZipPath', './7z.exe').ok).toBe(false)
  })

  it('rejects control characters in a path value', () => {
    const ctrl = (c: number) => 'C:\\a' + String.fromCharCode(c) + 'b'
    expect(validateSettingWrite('gamePath', ctrl(0)).ok).toBe(false) // NUL
    expect(validateSettingWrite('gamePath', ctrl(9)).ok).toBe(false) // tab
    expect(validateSettingWrite('gamePath', ctrl(10)).ok).toBe(false) // newline
  })

  it('guards every security-relevant path key against UNC', () => {
    for (const k of PATH_SETTING_KEYS) {
      expect(validateSettingWrite(k, '\\\\x\\y').ok).toBe(false)
    }
  })
})
