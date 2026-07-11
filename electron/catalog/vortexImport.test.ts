import { describe, it, expect } from 'vitest'
import { buildCatalogRowsFromBackup } from './vortexImport'

const mod = (over: Record<string, unknown> = {}) => ({
  modId: 151,
  fileId: 22253,
  name: 'Wild Herds of Skyrim',
  fileSize: 12_340_262,
  optional: false,
  phase: 0,
  collection: 'Mon Skyril',
  ...over,
})

describe('buildCatalogRowsFromBackup', () => {
  it('maps a well-formed deduped mod into a catalog row', () => {
    const [row] = buildCatalogRowsFromBackup({ deduped: [mod()] })
    expect(row).toMatchObject({
      nexus_id: 151,
      name: 'Wild Herds of Skyrim',
      category: 'Mon Skyril', // collection becomes the category
      priority_order: 1000, // banded after curated essentials
      required: 0,
      size_mb: 12, // 12.34 MB rounded
    })
    expect(row.notes).toContain('backup Vortex')
    // JSON-array columns are strings, ready for the modlist_catalog schema.
    expect(row.tags).toBe('[]')
    expect(row.requires).toBe('[]')
  })

  it('de-duplicates by modId (first wins)', () => {
    const rows = buildCatalogRowsFromBackup({
      deduped: [mod({ modId: 5, name: 'A' }), mod({ modId: 5, name: 'A dup' }), mod({ modId: 6, name: 'B' })],
    })
    expect(rows.map((r) => r.nexus_id)).toEqual([5, 6])
    expect(rows[0].name).toBe('A')
  })

  it('drops malformed entries (bad modId or empty name)', () => {
    const rows = buildCatalogRowsFromBackup({
      deduped: [
        mod({ modId: 0, name: 'zero' }),
        mod({ modId: -3, name: 'neg' }),
        mod({ modId: 1.5, name: 'float' }),
        mod({ modId: 7, name: '   ' }),
        mod({ modId: 8, name: undefined }),
        mod({ modId: 9, name: 'Valid' }),
      ],
    })
    expect(rows.map((r) => r.nexus_id)).toEqual([9])
  })

  it('falls back to a default category when the collection is missing', () => {
    const [row] = buildCatalogRowsFromBackup({ deduped: [mod({ collection: undefined })] })
    expect(row.category).toBe('Vortex')
  })

  it('bands priority by phase so ordering is stable', () => {
    const rows = buildCatalogRowsFromBackup({
      deduped: [mod({ modId: 1, phase: 0 }), mod({ modId: 2, phase: 3 })],
    })
    expect(rows.map((r) => r.priority_order)).toEqual([1000, 1003])
  })

  it('returns [] for a missing/empty/non-array deduped', () => {
    expect(buildCatalogRowsFromBackup(null)).toEqual([])
    expect(buildCatalogRowsFromBackup({})).toEqual([])
    expect(buildCatalogRowsFromBackup({ deduped: 'nope' })).toEqual([])
    expect(buildCatalogRowsFromBackup({ deduped: [] })).toEqual([])
  })
})
