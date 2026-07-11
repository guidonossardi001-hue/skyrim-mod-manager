import { describe, it, expect } from 'vitest'
import {
  parseResolution,
  buildVariants,
  selectVariant,
  resolveMods,
  isTextureProfile,
  type ModFile,
} from './textureProfile'

describe('parseResolution', () => {
  it('reads the resolution tag from a name (case-insensitive, optional space)', () => {
    expect(parseResolution('Feminine Grey Cat and Leopard (CBBE) 4K')).toBe('4K')
    expect(parseResolution('SomeMod 2k')).toBe('2K')
    expect(parseResolution('Ultra 8 K textures')).toBe('8K')
    expect(parseResolution('Base 1K')).toBe('1K')
  })
  it('returns null when there is no resolution tag', () => {
    expect(parseResolution('SkyUI')).toBeNull()
    expect(parseResolution('BodySlide - v5.7.1')).toBeNull()
    expect(parseResolution('4Kingdoms')).toBeNull() // not a standalone tag
    expect(parseResolution(null)).toBeNull()
  })
})

describe('buildVariants', () => {
  it('builds one variant per resolution from raw same-mod files', () => {
    const v = buildVariants([
      { fileId: 276958, name: 'Feminine (CBBE) 4K', fileSize: 300 },
      { fileId: 276959, name: 'Feminine (CBBE) 2K', fileSize: 120 },
      { fileId: 111, name: 'Readme (no res)', fileSize: 1 },
    ])
    expect(v.map((x) => x.resolution).sort()).toEqual(['2K', '4K'])
    expect(v.find((x) => x.resolution === '2K')?.fileId).toBe(276959)
  })
  it('keeps the first file seen per resolution and ignores untagged files', () => {
    const v = buildVariants([
      { fileId: 1, name: 'X 2K' },
      { fileId: 2, name: 'X 2K (mirror)' },
      { fileId: 3, name: 'X readme' },
    ])
    expect(v).toHaveLength(1)
    expect(v[0].fileId).toBe(1)
  })
})

const mod = (variants?: ModFile['variants']): ModFile => ({
  modId: 183,
  fileId: 276958, // base = the deduped 4K file
  name: 'Feminine (CBBE) 4K',
  md5: 'aaa',
  fileSize: 300,
  variants,
})

describe('selectVariant', () => {
  const variants = [
    { resolution: '4K' as const, fileId: 276958, name: '(CBBE) 4K', md5: 'h4', fileSize: 300 },
    { resolution: '2K' as const, fileId: 276959, name: '(CBBE) 2K', md5: 'h2', fileSize: 120 },
  ]

  it("picks the 2K file (id + size + md5) when the profile is '2K'", () => {
    const r = selectVariant(mod(variants), '2K')
    expect(r.fileId).toBe(276959)
    expect(r.fileSize).toBe(120)
    expect(r.md5).toBe('h2')
    expect(r.modId).toBe(183) // identity preserved
  })

  it("picks the 4K file when the profile is '4K'", () => {
    const r = selectVariant(mod(variants), '4K')
    expect(r.fileId).toBe(276958)
    expect(r.fileSize).toBe(300)
  })

  it('falls back to the nearest available when the exact resolution is missing', () => {
    // profile 2K, but only 1K + 4K exist → fallback order ['2K','1K',...] picks 1K
    const only1kAnd4k = [
      { resolution: '1K' as const, fileId: 10, name: '1K', fileSize: 60 },
      { resolution: '4K' as const, fileId: 40, name: '4K', fileSize: 300 },
    ]
    const r = selectVariant(mod(only1kAnd4k), '2K')
    expect(r.fileId).toBe(10) // 1K, the lighter fallback
    expect(r.fileSize).toBe(60)
  })

  it('leaves a mod WITHOUT variants unchanged (texture-only, no alternatives)', () => {
    const base = mod(undefined)
    expect(selectVariant(base, '2K')).toEqual(base)
  })
})

describe('resolveMods (list) — profile changes the selected files coherently', () => {
  const list: ModFile[] = [
    {
      modId: 183,
      fileId: 276958,
      name: '4K',
      fileSize: 300,
      variants: [
        { resolution: '4K', fileId: 276958, name: '4K', fileSize: 300 },
        { resolution: '2K', fileId: 276959, name: '2K', fileSize: 120 },
      ],
    },
    { modId: 500, fileId: 900, name: 'No variants', fileSize: 50 }, // unchanged either way
  ]

  it('selects the 4K set and its heavier sizes at profile 4K', () => {
    const r = resolveMods(list, '4K')
    expect(r.map((m) => m.fileId)).toEqual([276958, 900])
    expect(r.reduce((a, m) => a + (m.fileSize ?? 0), 0)).toBe(350)
  })

  it('selects the 2K set and its lighter sizes at profile 2K', () => {
    const r = resolveMods(list, '2K')
    expect(r.map((m) => m.fileId)).toEqual([276959, 900]) // 2K variant + the no-variant mod
    expect(r.reduce((a, m) => a + (m.fileSize ?? 0), 0)).toBe(170) // lighter total
  })
})

describe('isTextureProfile', () => {
  it('validates the setting value', () => {
    expect(isTextureProfile('2K')).toBe(true)
    expect(isTextureProfile('4K')).toBe(true)
    expect(isTextureProfile('8K')).toBe(false)
    expect(isTextureProfile('ultra')).toBe(false)
  })
})
