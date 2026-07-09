import { describe, it, expect } from 'vitest'
import { parseVdf, getLibraryPaths, parseAppManifest } from './vdf'

describe('parseVdf', () => {
  it('parses nested key-values', () => {
    const v = parseVdf('"root"\n{\n  "a" "1"\n  "b" { "c" "2" }\n}')
    expect(v).toEqual({ root: { a: '1', b: { c: '2' } } })
  })
  it('ignores // comments', () => {
    const v = parseVdf('"r" {\n  // comment\n  "x" "y"\n}')
    expect((v.r as Record<string, string>).x).toBe('y')
  })
})

describe('getLibraryPaths', () => {
  it('reads the modern libraryfolders.vdf format', () => {
    const text = `"libraryfolders"
{
  "0"
  {
    "path"  "C:\\\\Program Files (x86)\\\\Steam"
    "apps" { "489830" "12345" }
  }
  "1"
  {
    "path"  "D:\\\\SteamLibrary"
  }
}`
    expect(getLibraryPaths(parseVdf(text))).toEqual(['C:/Program Files (x86)/Steam', 'D:/SteamLibrary'])
  })

  it('reads the legacy flat format', () => {
    const text = '"LibraryFolders"\n{\n  "1" "E:\\\\Games\\\\Steam"\n}'
    expect(getLibraryPaths(parseVdf(text))).toEqual(['E:/Games/Steam'])
  })

  it('returns [] for an empty/foreign vdf', () => {
    expect(getLibraryPaths(parseVdf('"x" { "y" "z" }'))).toEqual([])
  })
})

describe('parseAppManifest', () => {
  it('extracts appid / name / installdir for Skyrim SE (489830)', () => {
    const text = `"AppState"
{
  "appid"  "489830"
  "name"  "The Elder Scrolls V: Skyrim Special Edition"
  "installdir"  "Skyrim Special Edition"
}`
    expect(parseAppManifest(text)).toEqual({
      appid: 489830,
      name: 'The Elder Scrolls V: Skyrim Special Edition',
      installdir: 'Skyrim Special Edition',
    })
  })
  it('returns null for a non-AppState document', () => {
    expect(parseAppManifest('"Other" { "appid" "1" }')).toBeNull()
  })
})
