import { describe, it, expect } from 'vitest'
import { isAddressLibraryBin, addressLibraryMatchesVersion } from './addressLibrary'

describe('isAddressLibraryBin', () => {
  it('accetta ENTRAMBI i naming reali: SE version-…bin e AE versionlib-…bin', () => {
    expect(isAddressLibraryBin('version-1-5-97-0.bin')).toBe(true)
    expect(isAddressLibraryBin('versionlib-1-6-1170-0.bin')).toBe(true) // il caso AE che bloccava l'avvio
    expect(isAddressLibraryBin('VERSIONLIB-1-6-640-0.BIN')).toBe(true)
  })
  it('rifiuta file estranei nella cartella SKSE/Plugins', () => {
    expect(isAddressLibraryBin('EngineFixes.dll')).toBe(false)
    expect(isAddressLibraryBin('versionlib.txt')).toBe(false)
    expect(isAddressLibraryBin('myversion-1-6-1170-0.bin')).toBe(false)
  })
})

describe('addressLibraryMatchesVersion', () => {
  const bins = ['versionlib-1-6-1170-0.bin', 'version-1-5-97-0.bin']
  it('true quando esiste il bin del runtime corrente', () => {
    expect(addressLibraryMatchesVersion(bins, '1.6.1170.0')).toBe(true)
    expect(addressLibraryMatchesVersion(bins, '1.5.97')).toBe(true)
  })
  it('false quando il runtime non ha un bin corrispondente', () => {
    expect(addressLibraryMatchesVersion(bins, '1.6.640.0')).toBe(false)
  })
  it('null (mai blocco spurio) senza bin o senza versione nota', () => {
    expect(addressLibraryMatchesVersion([], '1.6.1170.0')).toBeNull()
    expect(addressLibraryMatchesVersion(bins, null)).toBeNull()
    expect(addressLibraryMatchesVersion(bins, 'sconosciuta')).toBeNull()
  })
})
