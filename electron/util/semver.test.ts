import { describe, it, expect } from 'vitest'
import { isNewerVersion } from './semver'

describe('isNewerVersion', () => {
  it('più nuovo → true', () => {
    expect(isNewerVersion('1.0.2', '1.0.1')).toBe(true)
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('v1.0.2', '1.0.1')).toBe(true)
    expect(isNewerVersion('1.0.1.1', '1.0.1')).toBe(true)
  })

  it('caso reale del bug: feed fermo a 1.0.0 con app 1.0.1 → NON è un aggiornamento', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false)
  })

  it('uguale o più vecchio → false', () => {
    expect(isNewerVersion('1.0.1', '1.0.1')).toBe(false)
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false)
  })

  it('malformato/assente → false (mai prompt spuri)', () => {
    expect(isNewerVersion(null, '1.0.1')).toBe(false)
    expect(isNewerVersion(undefined, '1.0.1')).toBe(false)
    expect(isNewerVersion('abc', '1.0.1')).toBe(false)
    expect(isNewerVersion('1.0.2', 'garbage')).toBe(false)
    expect(isNewerVersion('', '1.0.1')).toBe(false)
  })

  it('pre-release/build ignorati (confronto sul core)', () => {
    expect(isNewerVersion('1.0.2-beta.1', '1.0.1')).toBe(true)
    expect(isNewerVersion('1.0.1-rc.1', '1.0.1')).toBe(false)
  })
})
