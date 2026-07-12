import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { registerInstalledMods } from './registerInstalled'

let db: SqliteDb

beforeEach(() => {
  db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE mods (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, category TEXT, file_size INTEGER DEFAULT 0, install_path TEXT,
      is_enabled INTEGER DEFAULT 1, is_installed INTEGER DEFAULT 0, priority INTEGER DEFAULT 0,
      deploy_category TEXT, resolution_weight INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE modlist_catalog (
      nexus_id INTEGER UNIQUE, category TEXT, priority_order INTEGER,
      deploy_category TEXT, resolution_weight INTEGER
    );
  `)
})

const row = (nexusId: number) =>
  db.prepare('SELECT * FROM mods WHERE profile_id=1 AND nexus_id=?').get(nexusId) as Record<
    string,
    unknown
  >

describe('registerInstalledMods', () => {
  it('INSERT: nuova estrazione → riga installata con metadati dal catalogo', () => {
    db.prepare(
      'INSERT INTO modlist_catalog (nexus_id, category, priority_order, deploy_category, resolution_weight) VALUES (7, ?, 42, ?, 4000)',
    ).run('Grafica', 'texture')
    const r = registerInstalledMods(db, 1, [
      { modId: 7, name: 'Texture Pack', installPath: 'D:/SG/mods/7-Texture Pack', fileSize: 123 },
    ])
    expect(r).toEqual({ inserted: 1, updated: 0, unchanged: 0 })
    const m = row(7)
    expect(m.is_installed).toBe(1)
    expect(m.install_path).toBe('D:/SG/mods/7-Texture Pack')
    expect(m.category).toBe('Grafica')
    expect(m.priority).toBe(42) // priority_order del catalogo
    expect(m.deploy_category).toBe('texture')
    expect(m.resolution_weight).toBe(4000)
  })

  it('UPDATE: riga esistente non installata viene promossa senza duplicare', () => {
    db.prepare("INSERT INTO mods (profile_id, nexus_id, name, is_installed) VALUES (1, 9, 'Preesistente', 0)").run()
    const r = registerInstalledMods(db, 1, [{ modId: 9, name: 'X', installPath: 'D:/SG/mods/9-X' }])
    expect(r).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    expect((db.prepare('SELECT COUNT(*) c FROM mods WHERE nexus_id=9').get() as { c: number }).c).toBe(1)
    expect(row(9).is_installed).toBe(1)
    expect(row(9).install_path).toBe('D:/SG/mods/9-X')
  })

  it('IDEMPOTENTE: secondo passaggio identico → unchanged, zero scritture', () => {
    const cand = [{ modId: 5, name: 'M', installPath: 'D:/SG/mods/5-M' }]
    registerInstalledMods(db, 1, cand)
    const r2 = registerInstalledMods(db, 1, cand)
    expect(r2).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
  })

  it('senza riga di catalogo: priorità in coda al profilo, sequenziale e stabile', () => {
    db.prepare("INSERT INTO mods (profile_id, nexus_id, name, priority) VALUES (1, 1, 'Esistente', 10)").run()
    registerInstalledMods(db, 1, [
      { modId: 2, name: 'A', installPath: 'D:/SG/mods/2-A' },
      { modId: 3, name: 'B', installPath: 'D:/SG/mods/3-B' },
    ])
    expect(row(2).priority).toBe(11)
    expect(row(3).priority).toBe(12)
    expect(row(2).category).toBe('StockGame') // fallback senza catalogo
  })

  it('profili separati: la registrazione su profilo 2 non tocca il profilo 1', () => {
    db.prepare("INSERT INTO mods (profile_id, nexus_id, name, is_installed) VALUES (1, 4, 'P1', 0)").run()
    const r = registerInstalledMods(db, 2, [{ modId: 4, name: 'P2', installPath: 'D:/SG/mods/4-P2' }])
    expect(r.inserted).toBe(1)
    expect(row(4).is_installed).toBe(0) // la riga del profilo 1 resta non installata
  })

  it('candidati malformati (modId non valido / path vuoto) vengono ignorati senza throw', () => {
    const r = registerInstalledMods(db, 1, [
      { modId: 0, name: 'Zero', installPath: 'D:/x' },
      { modId: 8, name: 'NoPath', installPath: '' },
      { modId: 6, name: 'Ok', installPath: 'D:/SG/mods/6-Ok' },
    ])
    expect(r.inserted).toBe(1)
  })
})
