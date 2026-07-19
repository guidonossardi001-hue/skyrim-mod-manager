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
