import { createHash } from 'crypto'
import type { SqliteDb } from '../db/sqlite'
import { withTransaction, tableExists, columnExists } from '../db/sqlite'
import { canonicalJSON } from '../delta/canonicalJson'
import { verifyCatalog } from './verify'
import { validateCatalog } from './validate'
import { effectiveBaseline, monotonicNow } from '../net/freshness'
import { pinnedCatalogFloor } from '../delta/pinnedKey'
import type { ModCatalog, SignedCatalog, CatalogIngestResult } from './types'

// Reference mod catalog ingestor (profile-independent metadata, distinct from
// the versioned delta release owned by ../delta/service.ts). Same shape as
// DeltaService.ingest: verify (trust boundary) → validate (shape/refs) →
// replace atomically. No-throw boundary — every path returns a
// CatalogIngestResult, never lets an exception escape ingest().

export interface CatalogServiceOptions {
  publicKeyPem: string
  log?: (level: 'info' | 'warn', msg: string) => void
}

const SETTINGS_VERSION_KEY = 'catalog_version'
const SETTINGS_HASH_KEY = 'catalog_hash'
const SETTINGS_GENERATED_AT_KEY = 'catalog_generated_at'

export class CatalogService {
  constructor(
    private db: SqliteDb,
    private opts: CatalogServiceOptions,
  ) {}

  private log(level: 'info' | 'warn', msg: string) {
    this.opts.log?.(level, msg)
  }

  private lastVersion(): number {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_VERSION_KEY) as
      | { value: string }
      | undefined
    const n = row ? Number(row.value) : 0
    return Number.isFinite(n) ? n : 0
  }

  private currentHash(): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_HASH_KEY) as
        | { value: string }
        | undefined
    )?.value
  }

  /** generated_at of the last accepted catalog (anti-rollback axis 2). */
  private lastGeneratedAt(): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_GENERATED_AT_KEY) as
          | { value: string }
          | undefined
      )?.value ?? null
    )
  }

  /** ingest = verify (trust boundary) → validate (shape/refs) → replace atomically. */
  ingest(signed: SignedCatalog): CatalogIngestResult {
    // Idempotent re-ingest: same content hash already applied is a no-op and
    // must NOT be treated as a downgrade just because its version is not > last.
    let hash: string
    try {
      hash = createHash('sha256').update(canonicalJSON(signed?.catalog)).digest('hex')
    } catch {
      return { success: false, errorKind: 'parse', error: 'catalogo non serializzabile' }
    }
    if (hash === this.currentHash()) return { success: true, reused: true }

    const baseline = effectiveBaseline(
      { lastCounter: this.lastVersion(), lastPublishedAt: this.lastGeneratedAt() },
      pinnedCatalogFloor(),
    )
    const v = verifyCatalog(signed, {
      publicKeyPem: this.opts.publicKeyPem,
      lastVersion: baseline.lastCounter,
      lastGeneratedAt: baseline.lastPublishedAt,
      now: monotonicNow(Date.now(), baseline.lastPublishedAt),
    })
    if (!v.ok || !v.catalog) {
      if (v.freshness) this.log('warn', `Update rejected: freshness violation — ${v.error}`)
      else this.log('warn', `catalogo rifiutato: ${v.error}`)
      return { success: false, errorKind: v.kind, error: v.error }
    }

    const val = validateCatalog(v.catalog)
    if (!val.ok) {
      this.log('warn', `catalogo non valido: ${val.errors.join('; ')}`)
      return { success: false, errorKind: 'schema', error: val.errors.join('; ') }
    }

    try {
      const inserted = this.replaceAll(v.catalog, hash)
      this.log('info', `catalogo v${v.catalog.catalog_version} ingerito: ${inserted} mod`)
      return { success: true, version: v.catalog.catalog_version, inserted, reused: false }
    } catch (e) {
      this.log('warn', `ingest catalogo fallito (rollback): ${(e as Error).message}`)
      return { success: false, errorKind: 'db', error: (e as Error).message }
    }
  }

  /** All-or-nothing: rows + version + hash bump inside ONE transaction. */
  private replaceAll(cat: ModCatalog, hash: string): number {
    return withTransaction(this.db, () => {
      this.db.exec('DELETE FROM modlist_catalog')
      // Conflict-resolution metadata (migration v8) is included only when the
      // columns exist, so a partial/legacy schema without them still ingests.
      const hasDeployMeta = columnExists(this.db, 'modlist_catalog', 'deploy_category')
      const cols = [
        'nexus_id', 'name', 'category', 'subcategory', 'priority_order', 'required',
        'description', 'author', 'tags', 'size_mb', 'has_it_translation', 'notes',
        'conflicts_with', 'requires',
        ...(hasDeployMeta ? ['deploy_category', 'resolution_weight'] : []),
      ]
      const ins = this.db.prepare(
        `INSERT INTO modlist_catalog (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`,
      )
      for (const m of cat.mods) {
        const vals: unknown[] = [
          m.nexus_id,
          m.name,
          m.category,
          m.subcategory ?? null,
          m.priority_order ?? 999,
          m.required ?? 0,
          m.description ?? null,
          m.author ?? null,
          JSON.stringify(m.tags ?? []),
          m.size_mb ?? 0,
          m.has_it_translation ?? 0,
          m.notes ?? null,
          JSON.stringify(m.conflicts_with ?? []),
          JSON.stringify(m.requires ?? []),
        ]
        if (hasDeployMeta) vals.push(m.deployCategory ?? null, m.resolutionWeight ?? null)
        ins.run(...vals)
      }
      // Denormalize install recipes into their own table IN THE SAME TRANSACTION,
      // so catalog rows and recipes commit (or roll back) together. Guarded: the
      // recipe table only exists after migration v7 — a partial/test schema without
      // it simply skips recipes rather than throwing (same convention as migrations).
      if (tableExists(this.db, 'mod_install_recipe')) {
        this.db.exec('DELETE FROM mod_install_recipe')
        const insR = this.db.prepare(
          'INSERT INTO mod_install_recipe (nexus_id, file_id, file_hash, schema_version, strategy, instructions) VALUES (?,?,?,?,?,?)',
        )
        for (const m of cat.mods) {
          if (!m.install) continue
          insR.run(
            m.nexus_id,
            null, // catalog recipes are the nexus-wide default (file-agnostic)
            null,
            m.install.schema_version ?? 1,
            m.install.strategy ?? 'root',
            JSON.stringify(m.install),
          )
        }
      }

      const up = this.db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      up.run(SETTINGS_VERSION_KEY, String(cat.catalog_version))
      up.run(SETTINGS_HASH_KEY, hash)
      up.run(SETTINGS_GENERATED_AT_KEY, cat.generated_at ?? '')
      return cat.mods.length
    })
  }
}
