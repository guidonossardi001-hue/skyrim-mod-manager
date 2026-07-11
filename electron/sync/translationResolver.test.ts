import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import {
  isItalianTranslation,
  baseNameOfTranslation,
  pairBackupTranslations,
  resolveTranslation,
  saveTranslations,
} from './translationResolver'

describe('isItalianTranslation', () => {
  it('flags Italian translation/patch names', () => {
    for (const n of [
      'SkyUI - Italian Translation',
      'Traduzione Italiana di Immersive Armors',
      'Immersive Armors ITA',
      'Some Mod - Italiano',
      'Mod Traduzione ITA',
    ]) {
      expect(isItalianTranslation(n), n).toBe(true)
    }
  })
  it('does NOT flag base mods / other languages', () => {
    for (const n of ['SkyUI', 'Immersive Armors', 'French Translation', 'Digital Italy Overhaul']) {
      expect(isItalianTranslation(n), n).toBe(false)
    }
    expect(isItalianTranslation(null)).toBe(false)
  })
})

describe('baseNameOfTranslation', () => {
  it('recovers the base mod name from a translation name', () => {
    expect(baseNameOfTranslation('SkyUI - Italian Translation').toLowerCase()).toBe('skyui')
    expect(baseNameOfTranslation('Immersive Armors ITA').toLowerCase()).toBe('immersive armors')
    expect(baseNameOfTranslation('Some Mod - Italiano').toLowerCase()).toBe('some mod')
  })
})

describe('pairBackupTranslations', () => {
  it('pairs a translation mod to its base by normalized base-name', () => {
    const pairs = pairBackupTranslations([
      { modId: 1137, name: 'SkyUI' },
      { modId: 9999, name: 'SkyUI - Italian Translation' },
      { modId: 200, name: 'Immersive Armors' },
      { modId: 201, name: 'Immersive Armors ITA' },
      { modId: 300, name: 'Lonely Mod (no translation)' },
    ])
    expect(pairs).toEqual([
      { base_nexus_id: 1137, translation_nexus_id: 9999, translation_file_id: null, translation_md5: null },
      { base_nexus_id: 200, translation_nexus_id: 201, translation_file_id: null, translation_md5: null },
    ])
  })
  it('skips a translation with no matching base (no guess)', () => {
    const pairs = pairBackupTranslations([{ modId: 5, name: 'Orphan Mod - Italian Translation' }])
    expect(pairs).toEqual([])
  })
})

describe('resolveTranslation + saveTranslations (DB)', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = openTestDb()
    applyPragmas(db)
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER, name TEXT NOT NULL);
      CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, name TEXT NOT NULL);
    `)
    runMigrations(db) // creates mod_translation (v10)
  })

  it('returns null when there is no mapping (fail-soft)', () => {
    expect(resolveTranslation(db, 1137)).toBeNull()
  })

  it('round-trips a saved mapping', () => {
    const written = saveTranslations(
      db,
      [{ base_nexus_id: 1137, translation_nexus_id: 9999, translation_file_id: 42, translation_md5: 'abc' }],
      'backup',
    )
    expect(written).toBe(1)
    expect(resolveTranslation(db, 1137)).toMatchObject({
      base_nexus_id: 1137,
      translation_nexus_id: 9999,
      translation_file_id: 42,
    })
  })

  it('upserts (a re-derived mapping overwrites in place)', () => {
    saveTranslations(db, [{ base_nexus_id: 1, translation_nexus_id: 10, translation_file_id: null, translation_md5: null }], 'backup')
    saveTranslations(db, [{ base_nexus_id: 1, translation_nexus_id: 20, translation_file_id: 5, translation_md5: null }], 'nexus')
    expect(resolveTranslation(db, 1)?.translation_nexus_id).toBe(20)
    expect((db.prepare('SELECT COUNT(*) c FROM mod_translation').get() as { c: number }).c).toBe(1)
  })

  it('returns null on a pre-v10 schema without the table (no throw)', () => {
    const bare = openTestDb()
    applyPragmas(bare)
    expect(resolveTranslation(bare, 1)).toBeNull()
  })
})
