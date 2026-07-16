import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  findAppManifest,
  readGuardStatus,
  setGuardProtection,
  checkVersionDrift,
  type UpdateGuardFsOps,
} from './updateGuard'

const APPID = 489830
const LIB = 'C:\\steam'
const ACF = join(LIB, 'steamapps', `appmanifest_${APPID}.acf`)

const ACF_TEXT = `"AppState"
{
  "appid" "489830"
  "name" "The Elder Scrolls V: Skyrim Special Edition"
  "buildid" "16543012"
  "AutoUpdateBehavior" "0"
}`

function fakeFs(overrides: Partial<UpdateGuardFsOps> & { readOnlyFiles?: Set<string> } = {}): UpdateGuardFsOps {
  const readOnly = overrides.readOnlyFiles ?? new Set<string>()
  return {
    exists: overrides.exists ?? ((p) => p === ACF),
    readFile: overrides.readFile ?? (() => ACF_TEXT),
    isReadOnly: overrides.isReadOnly ?? ((p) => readOnly.has(p)),
    setReadOnly:
      overrides.setReadOnly ??
      ((p, ro) => {
        if (ro) readOnly.add(p)
        else readOnly.delete(p)
      }),
  }
}

describe('findAppManifest', () => {
  it('trova l’acf nella prima libreria che lo contiene', () => {
    const exists = (p: string) => p === join('D:\\lib2', 'steamapps', `appmanifest_${APPID}.acf`)
    expect(findAppManifest(['C:\\lib1', 'D:\\lib2'], APPID, exists)).toBe(
      join('D:\\lib2', 'steamapps', `appmanifest_${APPID}.acf`),
    )
  })
  it('null quando nessuna libreria lo contiene', () => {
    expect(findAppManifest([LIB], APPID, () => false)).toBeNull()
  })
})

describe('readGuardStatus', () => {
  it('legge protezione + AutoUpdateBehavior + buildid dall’acf', () => {
    const st = readGuardStatus([LIB], APPID, fakeFs({ readOnlyFiles: new Set([ACF]) }))
    expect(st).toEqual({
      found: true,
      manifestPath: ACF,
      protected: true,
      autoUpdateBehavior: 0,
      buildId: '16543012',
    })
  })
  it('acf assente → found:false, mai throw', () => {
    const st = readGuardStatus([LIB], APPID, fakeFs({ exists: () => false }))
    expect(st.found).toBe(false)
    expect(st.protected).toBe(false)
  })
  it('acf illeggibile → campi vdf null ma stato protected valido', () => {
    const st = readGuardStatus(
      [LIB],
      APPID,
      fakeFs({
        readFile: () => {
          throw new Error('EACCES')
        },
      }),
    )
    expect(st.found).toBe(true)
    expect(st.autoUpdateBehavior).toBeNull()
    expect(st.buildId).toBeNull()
  })
})

describe('setGuardProtection', () => {
  it('attiva e disattiva la protezione (round-trip)', () => {
    const fs = fakeFs()
    const on = setGuardProtection(ACF, true, fs)
    expect(on).toEqual({ success: true, protected: true })
    const off = setGuardProtection(ACF, false, fs)
    expect(off).toEqual({ success: true, protected: false })
  })
  it('path nullo o inesistente → errore pulito, mai throw', () => {
    expect(setGuardProtection(null, true, fakeFs()).success).toBe(false)
    expect(setGuardProtection('X:\\nope.acf', true, fakeFs()).success).toBe(false)
  })
  it('verifica post-scrittura: attributo non applicato → success:false', () => {
    const fs = fakeFs({ setReadOnly: () => {}, isReadOnly: () => false })
    const r = setGuardProtection(ACF, true, fs)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/read-only/)
  })
  it('setReadOnly che lancia → errore riportato', () => {
    const fs = fakeFs({
      setReadOnly: () => {
        throw new Error('EPERM')
      },
    })
    expect(setGuardProtection(ACF, true, fs)).toEqual({
      success: false,
      protected: false,
      error: 'EPERM',
    })
  })
})

describe('checkVersionDrift', () => {
  it('null quando mai registrata o corrente ignota (primo avvio: nessun warning)', () => {
    expect(checkVersionDrift(null, '1.6.1170.0')).toBeNull()
    expect(checkVersionDrift('1.6.1170.0', null)).toBeNull()
    expect(checkVersionDrift(undefined, undefined)).toBeNull()
  })
  it('stessa versione → changed:false', () => {
    expect(checkVersionDrift('1.6.1170.0', '1.6.1170.0')).toEqual({
      changed: false,
      from: '1.6.1170.0',
      to: '1.6.1170.0',
    })
  })
  it('versione cambiata (update Steam) → changed:true con from/to', () => {
    expect(checkVersionDrift('1.6.1170.0', '1.6.1180.0')).toEqual({
      changed: true,
      from: '1.6.1170.0',
      to: '1.6.1180.0',
    })
  })
})
