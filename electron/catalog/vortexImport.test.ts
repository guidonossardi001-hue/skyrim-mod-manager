import { describe, it, expect } from 'vitest'
import { buildCatalogRowsFromBackup, removeVortexNameDuplicates, VORTEX_IMPORT_NOTE } from './vortexImport'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'

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

describe('removeVortexNameDuplicates', () => {
  function setup(): SqliteDb {
    const db = openTestDb()
    applyPragmas(db)
    db.exec(`CREATE TABLE modlist_catalog (id INTEGER PRIMARY KEY AUTOINCREMENT,
      nexus_id INTEGER UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, notes TEXT);`)
    return db
  }
  const add = (db: SqliteDb, nexus_id: number, name: string, notes: string | null) =>
    db.prepare('INSERT INTO modlist_catalog (nexus_id, name, category, notes) VALUES (?,?,?,?)').run(nexus_id, name, 'x', notes)
  const names = (db: SqliteDb) =>
    (db.prepare('SELECT nexus_id, name FROM modlist_catalog ORDER BY nexus_id').all() as { nexus_id: number; name: string }[])

  it('drops the CURATED row and keeps the Vortex row on a cross-source name collision', () => {
    const db = setup()
    add(db, 1137, 'SkyUI', null) // curated seed, placeholder id
    add(db, 12604, 'SkyUI', `${VORTEX_IMPORT_NOTE} (Mon Skyril)`) // vortex, real id
    const removed = removeVortexNameDuplicates(db)
    expect(removed).toBe(1)
    expect(names(db)).toEqual([{ nexus_id: 12604, name: 'SkyUI' }]) // authoritative id kept
  })

  it('is case/space-insensitive on the name match', () => {
    const db = setup()
    add(db, 100, '  True   Directional Movement ', null)
    add(db, 51614, 'true directional movement', `${VORTEX_IMPORT_NOTE}`)
    expect(removeVortexNameDuplicates(db)).toBe(1)
    expect(names(db)).toEqual([{ nexus_id: 51614, name: 'true directional movement' }])
  })

  it('does NOT touch within-Vortex generic-name collisions (distinct mods)', () => {
    const db = setup()
    add(db, 71227, 'Main File', `${VORTEX_IMPORT_NOTE} (A)`)
    add(db, 81017, 'Main File', `${VORTEX_IMPORT_NOTE} (B)`)
    add(db, 161963, 'Main File', `${VORTEX_IMPORT_NOTE} (C)`)
    expect(removeVortexNameDuplicates(db)).toBe(0)
    expect(names(db)).toHaveLength(3)
  })

  it('leaves a curated row with no Vortex twin untouched', () => {
    const db = setup()
    add(db, 555, 'Some Curated Only Mod', null)
    add(db, 12604, 'SkyUI', `${VORTEX_IMPORT_NOTE}`)
    expect(removeVortexNameDuplicates(db)).toBe(0)
    expect(names(db)).toHaveLength(2)
  })
})
