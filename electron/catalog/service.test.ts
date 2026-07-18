import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPairSync, createHash, sign as edSign } from 'crypto'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { canonicalJSON } from '../delta/canonicalJson'
import { CatalogService } from './service'
import type { ModCatalog, SignedCatalog } from './types'

// Same pattern as ../delta/core.test.ts / e2e.test.ts: node:sqlite in-memory db,
// real Ed25519 keypairs generated per test (no mocked crypto), real transactions.

function testDb(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE modlist_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nexus_id INTEGER UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority_order INTEGER DEFAULT 999,
      required INTEGER DEFAULT 0,
      description TEXT,
      author TEXT,
      tags TEXT DEFAULT '[]',
      size_mb INTEGER DEFAULT 0,
      has_it_translation INTEGER DEFAULT 0,
      notes TEXT,
      conflicts_with TEXT DEFAULT '[]',
      requires TEXT DEFAULT '[]'
    );
  `)
  return db
}

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  }
}

function signCatalog(
  catalog: ModCatalog,
  privateKey: ReturnType<typeof makeKeys>['privateKey'],
): SignedCatalog {
  const payload = Buffer.from(canonicalJSON(catalog), 'utf8')
  return {
    catalog,
    sha256: createHash('sha256').update(payload).digest('hex'),
    sig_ed25519: edSign(null, payload, privateKey).toString('hex'),
  }
}

const baseCatalog: ModCatalog = {
  catalog_version: 1,
  generated_at: '2026-07-10T00:00:00Z',
  source: 'test',
  mods: [
    { nexus_id: 1137, name: 'SkyUI', category: 'ui', priority_order: 10, required: 1 },
    { nexus_id: 2000, name: 'Framework X', category: 'framework', requires: [1137] },
  ],
}

function catalogRows(db: SqliteDb) {
  return db.prepare('SELECT id, nexus_id, name FROM modlist_catalog ORDER BY nexus_id').all()
}

describe('CatalogService.ingest', () => {
  let db: SqliteDb
  let keys: ReturnType<typeof makeKeys>
  let svc: CatalogService

  beforeEach(() => {
    db = testDb()
    keys = makeKeys()
    svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem })
  })

  it('accepts a correctly signed, fresh catalog and writes rows atomically', () => {
    const res = svc.ingest(signCatalog(baseCatalog, keys.privateKey))
    expect(res.success).toBe(true)
    expect(res.version).toBe(1)
    expect(res.inserted).toBe(2)
    expect(catalogRows(db)).toHaveLength(2)
    const row = db.prepare("SELECT value FROM settings WHERE key='catalog_version'").get() as {
      value: string
    }
    expect(row.value).toBe('1')
  })

  it('re-ingesting the identical catalog is idempotent (reused, no rewrite)', () => {
    const signed = signCatalog(baseCatalog, keys.privateKey)
    expect(svc.ingest(signed).success).toBe(true)
    const before = catalogRows(db)
    const again = svc.ingest(signed)
    expect(again.success).toBe(true)
    expect(again.reused).toBe(true)
    expect(catalogRows(db)).toEqual(before) // same row ids: no DELETE+reinsert happened
  })

  it('rejects a catalog signed by an untrusted key (authenticity) and touches no rows', () => {
    const attacker = makeKeys()
    const res = svc.ingest(signCatalog(baseCatalog, attacker.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('signature')
    expect(res.error).toMatch(/firma/i)
    expect(catalogRows(db)).toHaveLength(0)
  })

  it('rejects a tampered catalog body (hash no longer matches the signature)', () => {
    const signed = signCatalog(baseCatalog, keys.privateKey)
    signed.catalog.mods[0].name = 'Evil Injected Mod' // tamper after signing
    const res = svc.ingest(signed)
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('integrity')
    expect(res.error).toMatch(/hash/i)
    expect(catalogRows(db)).toHaveLength(0)
  })

  it('rejects replay/downgrade (catalog_version not strictly greater than last accepted)', () => {
    expect(svc.ingest(signCatalog(baseCatalog, keys.privateKey)).success).toBe(true) // version 1 accepted
    const stale: ModCatalog = { ...baseCatalog, generated_at: '2026-07-11T00:00:00Z' } // still version 1
    const res = svc.ingest(signCatalog(stale, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('downgrade')
    expect(catalogRows(db)).toHaveLength(2) // untouched: still the first accepted catalog
  })

  it('rejects a newer catalog_version carrying an OLDER generated_at (freshness axis 2)', () => {
    expect(svc.ingest(signCatalog(baseCatalog, keys.privateKey)).success).toBe(true) // v1 @ 2026-07-10
    const stale: ModCatalog = { ...baseCatalog, catalog_version: 2, generated_at: '2026-07-01T00:00:00Z' }
    const res = svc.ingest(signCatalog(stale, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('downgrade')
    expect(res.error).toMatch(/published_at/)
  })

  it('rejects a schema violation (duplicate nexus_id) and leaves the DB intact', () => {
    const dup: ModCatalog = {
      catalog_version: 1,
      generated_at: '2026-07-10T00:00:00Z',
      source: 'test',
      mods: [
        { nexus_id: 1137, name: 'SkyUI', category: 'ui' },
        { nexus_id: 1137, name: 'SkyUI Clone', category: 'ui' },
      ],
    }
    const res = svc.ingest(signCatalog(dup, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('schema')
    expect(res.error).toMatch(/duplicat/i)
    expect(catalogRows(db)).toHaveLength(0)
  })

  it('rejects a dangling reference (requires an absent nexus_id) and leaves the DB intact', () => {
    const dangling: ModCatalog = {
      catalog_version: 1,
      generated_at: '2026-07-10T00:00:00Z',
      source: 'test',
      mods: [{ nexus_id: 5, name: 'Orphan', category: 'other', requires: [9999] }],
    }
    const res = svc.ingest(signCatalog(dangling, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('schema')
    expect(res.error).toMatch(/assente/i)
    expect(catalogRows(db)).toHaveLength(0)
  })

  it('a validation failure after a prior successful ingest leaves the previous catalog untouched', () => {
    expect(svc.ingest(signCatalog(baseCatalog, keys.privateKey)).success).toBe(true)
    const before = catalogRows(db)
    const broken: ModCatalog = {
      catalog_version: 2,
      generated_at: 'later',
      source: 'test',
      mods: [
        { nexus_id: 1, name: 'A', category: 'x' },
        { nexus_id: 1, name: 'A dup', category: 'x' },
      ],
    }
    const res = svc.ingest(signCatalog(broken, keys.privateKey))
    expect(res.success).toBe(false)
    expect(catalogRows(db)).toEqual(before) // still v1's rows, no partial rewrite
  })

  it('rolls back the WHOLE replace on a DB-level failure mid-write (the DELETE is undone too)', () => {
    // Proves atomicity beyond pre-DB validation: even if something the validator
    // cannot model fails inside the transaction (disk full, unexpected constraint),
    // the prior catalog must survive — not be left half-deleted.
    expect(svc.ingest(signCatalog(baseCatalog, keys.privateKey)).success).toBe(true)
    const before = catalogRows(db)
    db.exec(`
      CREATE TRIGGER boom BEFORE INSERT ON modlist_catalog
      WHEN NEW.nexus_id = 666
      BEGIN SELECT RAISE(ABORT, 'simulated db failure'); END;
    `)
    const poisoned: ModCatalog = {
      catalog_version: 2,
      generated_at: '2026-07-10T00:00:00Z',
      source: 'test',
      mods: [{ nexus_id: 666, name: 'Poison', category: 'x' }],
    }
    const res = svc.ingest(signCatalog(poisoned, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('db')
    expect(catalogRows(db)).toEqual(before)
  })
})

// Deploy conflict metadata (migration v8): when the modlist_catalog table has the
// deploy_category / resolution_weight columns, ingest persists them from the signed
// CatalogModEntry so the deployer can auto-resolve file conflicts from real data.
describe('CatalogService.ingest — deploy conflict metadata (v8)', () => {
  let db: SqliteDb
  let keys: ReturnType<typeof makeKeys>
  let svc: CatalogService

  beforeEach(() => {
    db = testDb()
    // Simulate the post-v8 schema by adding the two auto-resolution columns.
    db.exec('ALTER TABLE modlist_catalog ADD COLUMN deploy_category TEXT')
    db.exec('ALTER TABLE modlist_catalog ADD COLUMN resolution_weight INTEGER')
    keys = makeKeys()
    svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem })
  })

  it('persists deployCategory/resolutionWeight into modlist_catalog (NULL when absent)', () => {
    const cat: ModCatalog = {
      catalog_version: 1,
      generated_at: '2026-07-10T00:00:00Z',
      source: 'test',
      mods: [
        { nexus_id: 100, name: 'HD 4K', category: 'graphics', deployCategory: 'texture', resolutionWeight: 4000 },
        { nexus_id: 200, name: 'Compat Patch', category: 'patch', deployCategory: 'patch' },
        { nexus_id: 300, name: 'Legacy', category: 'other' }, // no deploy metadata → NULLs
      ],
    }
    expect(svc.ingest(signCatalog(cat, keys.privateKey)).success).toBe(true)
    const rows = db
      .prepare('SELECT nexus_id, deploy_category AS c, resolution_weight AS w FROM modlist_catalog ORDER BY nexus_id')
      .all() as { nexus_id: number; c: string | null; w: number | null }[]
    expect(rows).toEqual([
      { nexus_id: 100, c: 'texture', w: 4000 },
      { nexus_id: 200, c: 'patch', w: null },
      { nexus_id: 300, c: null, w: null },
    ])
  })

  it('rejects an invalid deployCategory at the trust boundary', () => {
    const cat = {
      catalog_version: 1,
      generated_at: '2026-07-10T00:00:00Z',
      source: 'test',
      mods: [{ nexus_id: 1, name: 'Bad', category: 'x', deployCategory: 'ultra4k' }],
    } as unknown as ModCatalog
    const res = svc.ingest(signCatalog(cat, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('schema')
    expect(res.error).toMatch(/deployCategory/)
  })

  it('still ingests on a pre-v8 schema without the columns (guarded)', () => {
    const bare = testDb() // no ALTER ⇒ columns absent
    const svc2 = new CatalogService(bare, { publicKeyPem: keys.publicKeyPem })
    const cat: ModCatalog = {
      catalog_version: 1,
      generated_at: '2026-07-10T00:00:00Z',
      source: 'test',
      mods: [{ nexus_id: 1, name: 'A', category: 'x', deployCategory: 'mesh', resolutionWeight: 1 }],
    }
    expect(svc2.ingest(signCatalog(cat, keys.privateKey)).success).toBe(true)
    expect((bare.prepare('SELECT COUNT(*) AS c FROM modlist_catalog').get() as { c: number }).c).toBe(1)
  })
})

// Recipe denormalization (migration v7): when the mod_install_recipe table exists,
// ingest writes each entry's `install` into it IN THE SAME atomic transaction.
describe('CatalogService.ingest — install recipes', () => {
  let db: SqliteDb
  let keys: ReturnType<typeof makeKeys>
  let svc: CatalogService

  const recipes = (d: SqliteDb) =>
    d.prepare('SELECT nexus_id, strategy, instructions FROM mod_install_recipe ORDER BY nexus_id').all() as {
      nexus_id: number
      strategy: string
      instructions: string
    }[]

  beforeEach(() => {
    db = testDb()
    db.exec(`
      CREATE TABLE mod_install_recipe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nexus_id INTEGER NOT NULL, file_id INTEGER, file_hash TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1, strategy TEXT NOT NULL DEFAULT 'root',
        instructions TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX idx_recipe_nexus_file ON mod_install_recipe(nexus_id, file_id);
    `)
    keys = makeKeys()
    svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem })
  })

  const withRecipe: ModCatalog = {
    catalog_version: 1,
    generated_at: '2026-07-10T00:00:00Z',
    source: 'test',
    mods: [
      {
        nexus_id: 1137,
        name: 'SkyUI',
        category: 'ui',
        install: {
          schema_version: 1,
          strategy: 'recipe',
          rules: [{ op: 'include', match: '00 Core', stripPrefix: true }],
        },
      },
      { nexus_id: 2000, name: 'No Recipe Mod', category: 'framework' }, // no install → no recipe row
    ],
  }

  it('writes a recipe row only for entries that declare install', () => {
    expect(svc.ingest(signCatalog(withRecipe, keys.privateKey)).success).toBe(true)
    const rows = recipes(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].nexus_id).toBe(1137)
    expect(rows[0].strategy).toBe('recipe')
    expect(JSON.parse(rows[0].instructions).rules[0].match).toBe('00 Core')
  })

  it('rolls back recipe rows too when the transaction fails (atomic with the catalog)', () => {
    expect(svc.ingest(signCatalog(withRecipe, keys.privateKey)).success).toBe(true)
    const before = recipes(db)
    // Force a mid-transaction failure on the NEXT ingest and confirm recipes are unchanged.
    db.exec(`
      CREATE TRIGGER boom_recipe BEFORE INSERT ON modlist_catalog
      WHEN NEW.nexus_id = 777 BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `)
    const poisoned: ModCatalog = {
      catalog_version: 2,
      generated_at: 'later',
      source: 'test',
      mods: [{ nexus_id: 777, name: 'Poison', category: 'x', install: { schema_version: 1, strategy: 'root' } }],
    }
    const res = svc.ingest(signCatalog(poisoned, keys.privateKey))
    expect(res.success).toBe(false)
    expect(recipes(db)).toEqual(before) // recipe table not clobbered by the failed ingest
  })
})

describe('CatalogService.ingest — min_app_version gate', () => {
  let db: SqliteDb
  let keys: ReturnType<typeof makeKeys>

  beforeEach(() => {
    db = testDb()
    keys = makeKeys()
  })

  const withMinVersion = (v: string): ModCatalog => ({ ...baseCatalog, min_app_version: v })

  it('app più vecchia della minima richiesta → rifiutato, zero righe scritte', () => {
    const svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem, appVersion: '1.0.0' })
    const res = svc.ingest(signCatalog(withMinVersion('1.2.0'), keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('incompatible')
    expect(res.error).toMatch(/1\.2\.0/)
    expect(catalogRows(db)).toHaveLength(0)
  })

  it('app pari o più nuova della minima richiesta → accettato', () => {
    const svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem, appVersion: '1.2.0' })
    expect(svc.ingest(signCatalog(withMinVersion('1.2.0'), keys.privateKey)).success).toBe(true)

    const svc2 = new CatalogService(db, { publicKeyPem: keys.publicKeyPem, appVersion: '1.5.0' })
    const res2 = svc2.ingest(signCatalog(withMinVersion('1.2.0'), keys.privateKey))
    expect(res2.success).toBe(true)
  })

  it('catalogo senza min_app_version → nessun gate, sempre accettato', () => {
    const svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem, appVersion: '0.0.1' })
    expect(svc.ingest(signCatalog(baseCatalog, keys.privateKey)).success).toBe(true)
  })

  it('appVersion non iniettata (opts.appVersion assente) → gate saltato, retro-compatibile', () => {
    const svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem }) // niente appVersion
    const res = svc.ingest(signCatalog(withMinVersion('99.0.0'), keys.privateKey))
    expect(res.success).toBe(true)
  })

  it('min_app_version non stringa → rifiutato in validate (schema), non un throw', () => {
    const svc = new CatalogService(db, { publicKeyPem: keys.publicKeyPem, appVersion: '1.0.0' })
    const bad = { ...baseCatalog, min_app_version: 123 } as unknown as ModCatalog
    const res = svc.ingest(signCatalog(bad, keys.privateKey))
    expect(res.success).toBe(false)
    expect(res.errorKind).toBe('schema')
  })
})
