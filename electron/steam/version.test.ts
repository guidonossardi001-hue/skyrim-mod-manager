import { describe, it, expect } from 'vitest'
import { parseAddressLibVersion, parseSkseRuntimeVersion, gameVersionSupported } from './version'

describe('parseAddressLibVersion', () => {
  it('decodes the Address Library bin filename', () => {
    expect(parseAddressLibVersion('version-1-6-1170-0.bin')).toBe('1.6.1170.0')
    expect(parseAddressLibVersion('version-1-5-97-0.bin')).toBe('1.5.97.0')
  })
  it('returns null for non-matching names', () => {
    expect(parseAddressLibVersion('readme.txt')).toBeNull()
    expect(parseAddressLibVersion('versionlib-1-6.bin')).toBeNull()
  })
})

describe('parseSkseRuntimeVersion', () => {
  it('decodes the SKSE runtime DLL name', () => {
    expect(parseSkseRuntimeVersion('skse64_1_6_1170.dll')).toBe('1.6.1170')
    expect(parseSkseRuntimeVersion('skse64_1_5_97.dll')).toBe('1.5.97')
  })
  it('returns null for the loader or other files', () => {
    expect(parseSkseRuntimeVersion('skse64_loader.exe')).toBeNull()
    expect(parseSkseRuntimeVersion('skse64_steam_loader.dll')).toBeNull()
  })
})

describe('gameVersionSupported', () => {
  it('matches on the first three components (game 4-part vs SKSE 3-part)', () => {
    expect(gameVersionSupported('1.6.1170.0', '1.6.1170')).toBe(true)
  })
  it('detects a mismatch (SKSE for a different build)', () => {
    expect(gameVersionSupported('1.6.1170.0', '1.6.640')).toBe(false)
    expect(gameVersionSupported('1.6.640.0', '1.5.97')).toBe(false)
  })
  it('returns null (no spurious block) when data is missing/partial', () => {
    expect(gameVersionSupported(null, '1.6.1170')).toBeNull()
    expect(gameVersionSupported('1.6.1170.0', null)).toBeNull()
    expect(gameVersionSupported('1.6', '1.6')).toBeNull() // not enough components
  })
})
