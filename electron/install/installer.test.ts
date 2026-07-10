import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import {
  InstallerService,
  sweepStaging,
  recoverReinstalls,
  type Extractor,
  type ExtractRequest,
} from './installer'
import type { InstallInstructions as II } from './recipe'

// Integration: real tmp mods folder + in-memory node:sqlite, with the 7-Zip call
// mocked by a fake Extractor that writes the "extracted" tree into staging/raw.
// This exercises the full orchestration (recipe resolve → stage → map → commit →
// cleanup) and, crucially, the atomicity guarantee: a mid-process failure must
// leave NO final mod folder and NO staging behind.

const FOMOD_ARCHIVE = [
  '00 Core/meshes/armor.nif',
  '00 Core/textures/armor.dds',
  '01 Option 2K/textures/armor.dds',
  '02 Option 4K/textures/armor.dds',
  'fomod/ModuleConfig.xml',
  'readme.txt',
]

function recipeTable(db: SqliteDb) {
  db.exec(`
    CREATE TABLE mod_install_recipe (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nexus_id       INTEGER NOT NULL,
      file_id        INTEGER,
      file_hash      TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      strategy       TEXT NOT NULL DEFAULT 'root',
      instructions   TEXT NOT NULL,
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_recipe_nexus_file ON mod_install_recipe(nexus_id, file_id);
  `)
}

function seedRecipe(
  db: SqliteDb,
  nexusId: number,
  fileId: number | null,
  inst: II,
  fileHash: string | null = null,
) {
  db.prepare(
    'INSERT INTO mod_install_recipe (nexus_id, file_id, file_hash, schema_version, strategy, instructions) VALUES (?,?,?,?,?,?)',
  ).run(nexusId, fileId, fileHash, inst.schema_version ?? 1, inst.strategy, JSON.stringify(inst))
}

/** Fake extractor: writes the given file list under destDir; captures the request. */
function makeExtractor(
  files: string[],
  hooks?: { capture?: (r: ExtractRequest) => void; throwErr?: Error },
): Extractor {
  return async (req) => {
    hooks?.capture?.(req)
    if (hooks?.throwErr) throw hooks.throwErr
    for (const f of files) {
      const abs = join(req.destDir, f)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, 'x')
    }
    return { method: '7za' }
  }
}

let root: string // the mods root
let archive: string // a real archive file (for stat + hashing)
let db: SqliteDb
let n = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smm-installer-'))
  archive = join(root, 'archive.bin')
  writeFileSync(archive, Buffer.from('pretend archive bytes'))
  db = openTestDb()
  applyPragmas(db)
  recipeTable(db)
  n = 0
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const service = (extract: Extractor) =>
  new InstallerService({ db, modsRoot: () => root, extract, uuid: () => `u${n++}` })

const stagingEntries = () => {
  const s = join(root, '.staging')
  return existsSync(s) ? readdirSync(s) : []
}

const CORE_4K: II = {
  schema_version: 1,
  strategy: 'recipe',
  rules: [
    { op: 'include', match: '00 Core', stripPrefix: true },
    { op: 'include', match: '02 Option 4K', stripPrefix: true },
  ],
  expect: { minFiles: 2, mustContain: ['meshes/armor.nif', 'textures/armor.dds'] },
}

describe('InstallerService.installMod', () => {
  it('happy path (recipe): deploys the selected tree, drops the rest, cleans staging', async () => {
    seedRecipe(db, 1, 10, CORE_4K)
    const svc = service(makeExtractor(FOMOD_ARCHIVE))
    const r = await svc.installMod(1, 10, null, archive, { modName: 'MyMod' })

    expect(r.success).toBe(true)
    expect(r.strategy).toBe('recipe')
    expect(r.recipeSource).toBe('exact')
    expect(r.filesDeployed).toBe(2)
    const modDir = join(root, 'MyMod')
    expect(existsSync(join(modDir, 'meshes', 'armor.nif'))).toBe(true)
    expect(existsSync(join(modDir, 'textures', 'armor.dds'))).toBe(true)
    // implicit drop
    expect(existsSync(join(modDir, '01 Option 2K'))).toBe(false)
    expect(existsSync(join(modDir, 'fomod'))).toBe(false)
    expect(existsSync(join(modDir, 'readme.txt'))).toBe(false)
    // staging fully swept
    expect(stagingEntries()).toEqual([])
  })

  it('passes recipe-derived 7z include filters to the extractor', async () => {
    seedRecipe(db, 1, 10, CORE_4K)
    let captured: ExtractRequest | null = null
    const svc = service(makeExtractor(FOMOD_ARCHIVE, { capture: (r) => (captured = r) }))
    await svc.installMod(1, 10, null, archive, { modName: 'MyMod' })
    expect(captured!.includeFilters).toEqual(['00 Core', '02 Option 4K'])
  })

  it('falls back to the nexus-wide default recipe (file_id NULL) when no exact match', async () => {
    seedRecipe(db, 1, null, CORE_4K) // default recipe
    const svc = service(makeExtractor(FOMOD_ARCHIVE))
    const r = await svc.installMod(1, 999, null, archive, { modName: 'MyMod' }) // fileId with no exact row
    expect(r.success).toBe(true)
    expect(r.recipeSource).toBe('nexus')
  })

  it("uses the default 'root' strategy when the mod has no recipe at all", async () => {
    const svc = service(makeExtractor(['a.esp', 'textures/b.dds']))
    const r = await svc.installMod(7, null, null, archive, { modName: 'Flat' })
    expect(r.success).toBe(true)
    expect(r.strategy).toBe('root')
    expect(r.recipeSource).toBe('default')
    expect(existsSync(join(root, 'Flat', 'a.esp'))).toBe(true)
    expect(existsSync(join(root, 'Flat', 'textures', 'b.dds'))).toBe(true)
  })

  // ── The atomicity guarantee the task calls out ──────────────────────────────

  it('expect post-condition failure leaves NO final folder and removes staging', async () => {
    const badRecipe: II = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 Core', stripPrefix: true }],
      expect: { mustContain: ['SKSE/Plugins/vital.dll'] }, // never present in the archive
    }
    seedRecipe(db, 1, 10, badRecipe)
    const svc = service(makeExtractor(FOMOD_ARCHIVE))
    const r = await svc.installMod(1, 10, null, archive, { modName: 'MyMod' })

    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('recipe')
    expect(existsSync(join(root, 'MyMod'))).toBe(false) // final dir NEVER created
    expect(stagingEntries()).toEqual([]) // staging removed
  })

  it('recipe-slip is blocked, mapped to errorKind recipe-slip, nothing deployed', async () => {
    const evil: II = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        { op: 'rename', match: '00 Core/textures/armor.dds', to: '../../../evil.dll' },
      ],
    }
    seedRecipe(db, 1, 10, evil)
    const svc = service(makeExtractor(FOMOD_ARCHIVE))
    const r = await svc.installMod(1, 10, null, archive, { modName: 'MyMod' })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('recipe-slip')
    expect(existsSync(join(root, 'MyMod'))).toBe(false)
    expect(stagingEntries()).toEqual([])
  })

  it('rejects a hash mismatch before extracting (no staging, no final)', async () => {
    const svc = service(makeExtractor(FOMOD_ARCHIVE))
    const r = await svc.installMod(1, 10, 'deadbeef'.repeat(8), archive, { modName: 'MyMod' })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('hash')
    expect(existsSync(join(root, 'MyMod'))).toBe(false)
    expect(stagingEntries()).toEqual([])
  })

  it('accepts a correct archive hash and proceeds', async () => {
    const good = createHash('sha256').update(Buffer.from('pretend archive bytes')).digest('hex')
    const svc = service(makeExtractor(['a.esp']))
    const r = await svc.installMod(3, null, good, archive, { modName: 'Hashed' })
    expect(r.success).toBe(true)
    expect(existsSync(join(root, 'Hashed', 'a.esp'))).toBe(true)
  })

  it('maps an aborted extraction to errorKind cancelled and cleans up', async () => {
    seedRecipe(db, 1, 10, CORE_4K)
    const svc = service(makeExtractor(FOMOD_ARCHIVE, { throwErr: new Error('annullato') }))
    const r = await svc.installMod(1, 10, null, archive, { modName: 'MyMod' })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('cancelled')
    expect(stagingEntries()).toEqual([])
  })

  it('refuses to overwrite an existing mod without force, but succeeds with force', async () => {
    const svc = service(makeExtractor(['a.esp']))
    mkdirSync(join(root, 'Dup'), { recursive: true })
    writeFileSync(join(root, 'Dup', 'old.esp'), 'old')

    const blocked = await svc.installMod(5, null, null, archive, { modName: 'Dup' })
    expect(blocked.success).toBe(false)
    expect(blocked.errorKind).toBe('commit')
    expect(existsSync(join(root, 'Dup', 'old.esp'))).toBe(true) // untouched
    expect(stagingEntries()).toEqual([])

    const forced = await svc.installMod(5, null, null, archive, { modName: 'Dup', force: true })
    expect(forced.success).toBe(true)
    expect(existsSync(join(root, 'Dup', 'a.esp'))).toBe(true)
    expect(existsSync(join(root, 'Dup', 'old.esp'))).toBe(false) // replaced
  })

  it('returns not-found for a missing archive', async () => {
    const svc = service(makeExtractor([]))
    const r = await svc.installMod(1, null, null, join(root, 'nope.bin'), {})
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('not-found')
  })
})

describe('sweepStaging', () => {
  it('removes orphaned staging directories left by a crash', () => {
    const s = join(root, '.staging')
    mkdirSync(join(s, '1-orphan', 'raw'), { recursive: true })
    mkdirSync(join(s, '2-orphan'), { recursive: true })
    expect(readdirSync(s)).toHaveLength(2)
    const removed = sweepStaging(root)
    expect(removed).toBe(2)
    expect(readdirSync(s)).toEqual([])
  })

  it('is a no-op when there is no staging folder', () => {
    expect(sweepStaging(root)).toBe(0)
  })
})

describe('recoverReinstalls (atomic-swap crash recovery)', () => {
  it('restores the backup when the new install is missing (crash before commit)', () => {
    mkdirSync(join(root, 'ModA.smm-old'), { recursive: true })
    writeFileSync(join(root, 'ModA.smm-old', 'keep.esp'), 'old')
    expect(recoverReinstalls(root)).toBe(1)
    expect(existsSync(join(root, 'ModA.smm-old'))).toBe(false)
    expect(existsSync(join(root, 'ModA', 'keep.esp'))).toBe(true) // previous install restored
  })

  it('discards a stale backup when the new install is present (crash after commit)', () => {
    mkdirSync(join(root, 'ModB'), { recursive: true })
    writeFileSync(join(root, 'ModB', 'new.esp'), 'new')
    mkdirSync(join(root, 'ModB.smm-old'), { recursive: true })
    writeFileSync(join(root, 'ModB.smm-old', 'old.esp'), 'old')
    expect(recoverReinstalls(root)).toBe(1)
    expect(existsSync(join(root, 'ModB.smm-old'))).toBe(false) // stale backup discarded
    expect(existsSync(join(root, 'ModB', 'new.esp'))).toBe(true) // committed install untouched
  })

  it('is a no-op when there is no interrupted reinstall', () => {
    expect(recoverReinstalls(root)).toBe(0)
  })
})
