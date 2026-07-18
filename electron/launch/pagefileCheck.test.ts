import { describe, it, expect } from 'vitest'
import { evaluatePagefile, queryPagefileInfo, MIN_FIXED_PAGEFILE_MB } from './pagefileCheck'

describe('evaluatePagefile', () => {
  it('gestito automaticamente da Windows → ok, mai un avviso (indipendentemente da totalMB)', () => {
    const r = evaluatePagefile({ autoManaged: true, totalMB: null })
    expect(r).toEqual({ checked: true, concerning: false, detail: 'Gestito automaticamente da Windows' })
  })

  it('fisso e sopra soglia (20GB+) → ok', () => {
    const r = evaluatePagefile({ autoManaged: false, totalMB: MIN_FIXED_PAGEFILE_MB })
    expect(r.checked).toBe(true)
    expect(r.concerning).toBe(false)
  })

  it('fisso e sotto soglia → concerning, mai un blocco (solo checked+concerning)', () => {
    const r = evaluatePagefile({ autoManaged: false, totalMB: 4096 })
    expect(r.checked).toBe(true)
    expect(r.concerning).toBe(true)
    expect(r.detail).toContain('4.0 GB')
  })

  it('esattamente alla soglia → ok (>=, non un off-by-one)', () => {
    expect(evaluatePagefile({ autoManaged: false, totalMB: MIN_FIXED_PAGEFILE_MB }).concerning).toBe(false)
    expect(evaluatePagefile({ autoManaged: false, totalMB: MIN_FIXED_PAGEFILE_MB - 1 }).concerning).toBe(true)
  })

  it('probe fallito (entrambi i dati null) → checked:false, mai un avviso spurio', () => {
    const r = evaluatePagefile({ autoManaged: null, totalMB: null })
    expect(r).toEqual({ checked: false, concerning: false, detail: '' })
  })

  it('autoManaged false ma totalMB ignoto (probe parziale) → checked:false, dato insufficiente', () => {
    const r = evaluatePagefile({ autoManaged: false, totalMB: null })
    expect(r.checked).toBe(false)
  })
})

describe('queryPagefileInfo', () => {
  it('JSON valido → autoManaged/totalMB popolati', () => {
    const fakeExec = () => JSON.stringify({ AutoManaged: false, TotalMB: 24576 })
    const info = queryPagefileInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(info).toEqual({ autoManaged: false, totalMB: 24576 })
  })

  it('PowerShell che lancia (assente/timeout) → dati null, mai un throw propagato', () => {
    const fakeExec = () => {
      throw new Error('powershell not found')
    }
    expect(() =>
      queryPagefileInfo(fakeExec as unknown as typeof import('child_process').execFileSync),
    ).not.toThrow()
    const info = queryPagefileInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(info).toEqual({ autoManaged: null, totalMB: null })
  })

  it('JSON malformato → dati null, mai un throw propagato', () => {
    const fakeExec = () => 'not-json{{{'
    const info = queryPagefileInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(info).toEqual({ autoManaged: null, totalMB: null })
  })

  it('TotalMB negativo (dato implausibile) → trattato come non attendibile', () => {
    const fakeExec = () => JSON.stringify({ AutoManaged: false, TotalMB: -1 })
    const info = queryPagefileInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(info.totalMB).toBeNull()
  })
})

