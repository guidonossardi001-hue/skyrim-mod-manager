// Orchestrazione main-process della rilevazione conflitti record-level (CONFLICTS Fase 2):
// collega il load order REALE (plugins.txt + Data deployata, stessa fonte di plugin:get-order)
// all'indice SQLite e produce il report tracciato per la UI. Sola lettura sul disco di gioco;
// scrive solo nel DB del launcher.
//
// Confini IPC (stessa policy del resto dell'app): il renderer non manda MAI path — solo
// filtri (stringhe corte), form_key e flag. I path li risolve il main process.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SqliteDb } from '../db/sqlite'
import { getLoadOrder } from '../pluginManager'
import { readPluginHeader } from '../plugins/espParser'
import {
  indexLoadOrderAsync,
  listConflicts,
  type ConflictPluginInput,
  type IndexProgress,
  type IndexSummary,
} from './conflictIndex'
import {
  trackConflicts,
  loadIgnoredKeys,
  type TrackedConflict,
  type ConflictStatus,
  type TrackSummary,
} from './patchTracker'
import { isLightSpace } from './formKey'
import { snapshotRecord, buildDiffRows, type RecordSnapshot, type RecordDiffRow } from './recordDiff'

/** Nome di default della patch di risoluzione personale (override via settings). */
export const DEFAULT_PATCH_NAME = 'FantasyLauncher_Output.esp'

export interface ConflictScanResult {
  ok: boolean
  error?: string
  pluginsActive?: number
  summary?: IndexSummary
}

/**
 * Indicizza il load order attivo. `dataDir`/`pluginsTxtPath` arrivano dai resolver di
 * main.ts (mai dal renderer). Async: cede l'event loop tra un plugin e l'altro.
 */
export async function runConflictScan(
  db: SqliteDb,
  opts: { dataDir: string; pluginsTxtPath: string },
  onProgress?: (p: IndexProgress) => void,
): Promise<ConflictScanResult> {
  if (!opts.dataDir || !existsSync(opts.dataDir)) {
    return { ok: false, error: 'Nessuna Data deployata trovata: esegui prima un Deploy' }
  }
  const entries = getLoadOrder({ dataDir: opts.dataDir, pluginsTxtPath: opts.pluginsTxtPath })
  const active: ConflictPluginInput[] = entries
    .filter((e) => e.active)
    .map((e) => ({ name: e.name, path: join(opts.dataDir, e.name) }))
  if (active.length === 0) return { ok: false, error: 'Nessun plugin attivo nel load order' }
  const summary = await indexLoadOrderAsync(db, active, onProgress)
  return { ok: true, pluginsActive: active.length, summary }
}

export interface ConflictReportFilter {
  /** Solo conflitti in questi stati (vuoto/assente = tutti). */
  statuses?: ConflictStatus[]
  /** Match case-insensitive su formKey, EDID, signature o nome plugin partecipante. */
  search?: string
  /** Cap sul numero di voci ritornate al renderer (il summary resta sull'insieme COMPLETO). */
  limit?: number
}

export interface ConflictReport {
  ok: boolean
  error?: string
  patchName?: string
  summary?: TrackSummary
  /** Voci filtrate e cappate a `limit` — `truncated` dice se ne esistono altre. */
  items?: TrackedConflict[]
  truncated?: boolean
}

export const DEFAULT_REPORT_LIMIT = 2000

/** Filtro puro sul report tracciato (testabile senza DB/fs). */
export function filterTrackedConflicts(
  items: TrackedConflict[],
  filter: ConflictReportFilter,
): { items: TrackedConflict[]; truncated: boolean } {
  let out = items
  if (filter.statuses && filter.statuses.length > 0) {
    const wanted = new Set(filter.statuses)
    out = out.filter((c) => wanted.has(c.status))
  }
  const q = filter.search?.trim().toLowerCase()
  if (q) {
    out = out.filter(
      (c) =>
        c.formKey.includes(q) ||
        c.signature.toLowerCase().includes(q) ||
        (c.edid ?? '').toLowerCase().includes(q) ||
        c.participants.some((p) => p.plugin.includes(q)),
    )
  }
  const limit = Math.max(1, Math.trunc(filter.limit ?? DEFAULT_REPORT_LIMIT))
  if (out.length > limit) return { items: out.slice(0, limit), truncated: true }
  return { items: out, truncated: false }
}

/**
 * Report completo dallo stato corrente dell'indice (nessuna scansione qui: prima si
 * chiama runConflictScan). Ordina i non-risolti in testa (unresolved > shadowed >
 * identical > resolved > ignored), a parità per formKey.
 */
export function getConflictReport(
  db: SqliteDb,
  patchName: string,
  filter: ConflictReportFilter = {},
): ConflictReport {
  const conflicts = listConflicts(db, { excludeFromCount: patchName })
  const ignored = loadIgnoredKeys(db)
  const { items, summary } = trackConflicts(conflicts, { patchName, ignored })
  const rank: Record<ConflictStatus, number> = {
    unresolved: 0,
    shadowed: 1,
    identical: 2,
    resolved: 3,
    ignored: 4,
  }
  items.sort((a, b) => rank[a.status] - rank[b.status] || a.formKey.localeCompare(b.formKey))
  const filtered = filterTrackedConflicts(items, filter)
  return { ok: true, patchName, summary, items: filtered.items, truncated: filtered.truncated }
}

// ── Dettaglio record (diff subrecord) + partecipanti per il lancio xEdit ────────────

interface ParticipantRow {
  plugin: string
  display_name: string
  path: string
  order_idx: number
  edid: string | null
}

function participantRows(db: SqliteDb, formKey: string): ParticipantRow[] {
  return db
    .prepare(
      `SELECT r.plugin, p.display_name, p.path, p.order_idx, r.edid
         FROM conflict_record r
         JOIN conflict_plugin_scan p ON p.plugin = r.plugin
        WHERE r.form_key = ?
        ORDER BY p.order_idx`,
    )
    .all(formKey) as ParticipantRow[]
}

/** Lookup light memoizzato sui plugin dell'indice: stessa regola di mask dell'indicizzazione. */
function makeIsLight(db: SqliteDb): (name: string) => boolean | undefined {
  const cache = new Map<string, boolean | undefined>()
  const sel = db.prepare('SELECT path FROM conflict_plugin_scan WHERE plugin = ?')
  return (name: string) => {
    const key = name.toLowerCase()
    if (cache.has(key)) return cache.get(key)
    const row = sel.get(key) as { path: string } | undefined
    const value = row ? isLightSpace(name, readPluginHeader(row.path)?.isLight) : undefined
    cache.set(key, value)
    return value
  }
}

export interface RecordDetailResult {
  ok: boolean
  error?: string
  formKey?: string
  snapshots?: RecordSnapshot[]
  rows?: RecordDiffRow[]
}

/**
 * Diff subrecord on-demand del record `formKey` tra tutti i partecipanti indicizzati.
 * Un walk con early-stop per partecipante (centinaia di ms sul peggiore, Skyrim.esm).
 */
export function getRecordDetail(db: SqliteDb, formKey: string): RecordDetailResult {
  const parts = participantRows(db, formKey)
  if (parts.length === 0) {
    return { ok: false, error: 'Record non presente nell’indice: riesegui la scansione' }
  }
  const isLight = makeIsLight(db)
  const snapshots = parts.map((p) =>
    snapshotRecord({ plugin: p.plugin, displayName: p.display_name, path: p.path }, formKey, isLight),
  )
  return { ok: true, formKey, snapshots, rows: buildDiffRows(snapshots) }
}

export interface XeditTargets {
  ok: boolean
  error?: string
  /** Display name dei partecipanti in ordine di caricamento. */
  participants?: string[]
  edid?: string | null
}

/** Partecipanti + EDID (primo non-null) per costruire il lancio mirato di xEdit. */
export function getXeditTargets(db: SqliteDb, formKey: string): XeditTargets {
  const parts = participantRows(db, formKey)
  if (parts.length === 0) {
    return { ok: false, error: 'Record non presente nell’indice: riesegui la scansione' }
  }
  return {
    ok: true,
    participants: parts.map((p) => p.display_name),
    edid: parts.find((p) => p.edid)?.edid ?? null,
  }
}
