// Tracking della patch di risoluzione personale (es. FantasyLauncher_Output.esp) sui
// conflitti rilevati (CONFLICTS Fase 1). Classificazione PURA su ConflictEntry; le
// uniche funzioni con DB sono il persist della lista "ignora".
//
// Stati (in ordine di verifica):
//   ignored    — l'utente ha marcato la chiave come non-problema (persistito in SQLite);
//   resolved   — la patch overrida la chiave ED è l'ultimo partecipante: vince a runtime;
//   shadowed   — la patch overrida la chiave ma QUALCOSA carica dopo e la sovrascrive:
//                risoluzione presente ma inefficace (ordine da sistemare);
//   identical  — tutti gli override (patch esclusa) hanno lo stesso CRC: nessuna scelta
//                da fare, il "conflitto" è cosmetico;
//   unresolved — conflitto reale non coperto dalla patch.

import { withTransaction, type SqliteDb } from '../db/sqlite'
import { ensureConflictSchema, type ConflictEntry } from './conflictIndex'

export type ConflictStatus = 'ignored' | 'resolved' | 'shadowed' | 'identical' | 'unresolved'

export interface TrackedConflict extends ConflictEntry {
  status: ConflictStatus
  /** Plugin (lowercase) che vince a runtime: ultimo partecipante in ordine di caricamento. */
  winner: string
}

export interface TrackSummary {
  total: number
  byStatus: Record<ConflictStatus, number>
}

export interface TrackOptions {
  /** Nome file della patch di risoluzione (case-insensitive). */
  patchName: string
  /** Chiavi ignorate dall'utente (da loadIgnoredKeys). */
  ignored?: Set<string>
}

export function classifyConflict(
  c: ConflictEntry,
  patchNameLower: string,
  ignored: Set<string>,
): { status: ConflictStatus; winner: string } {
  // participants è già ordinato per order_idx (contratto di listConflicts).
  const winner = c.participants[c.participants.length - 1]?.plugin ?? ''
  if (ignored.has(c.formKey)) return { status: 'ignored', winner }
  const patchIsIn = c.participants.some((p) => p.plugin === patchNameLower)
  if (patchIsIn) return { status: winner === patchNameLower ? 'resolved' : 'shadowed', winner }
  if (c.identicalOverrides) return { status: 'identical', winner }
  return { status: 'unresolved', winner }
}

export function trackConflicts(
  conflicts: ConflictEntry[],
  opts: TrackOptions,
): { items: TrackedConflict[]; summary: TrackSummary } {
  const patchLower = opts.patchName.toLowerCase()
  const ignored = opts.ignored ?? new Set<string>()
  const byStatus: Record<ConflictStatus, number> = {
    ignored: 0,
    resolved: 0,
    shadowed: 0,
    identical: 0,
    unresolved: 0,
  }
  const items = conflicts.map((c) => {
    const { status, winner } = classifyConflict(c, patchLower, ignored)
    byStatus[status]++
    return { ...c, status, winner }
  })
  return { items, summary: { total: items.length, byStatus } }
}

export function loadIgnoredKeys(db: SqliteDb): Set<string> {
  ensureConflictSchema(db)
  const rows = db.prepare('SELECT form_key FROM conflict_ignore').all() as { form_key: string }[]
  return new Set(rows.map((r) => r.form_key))
}

export function setIgnored(db: SqliteDb, formKey: string, ignored: boolean, reason?: string): void {
  ensureConflictSchema(db)
  withTransaction(db, () => {
    if (ignored) {
      db.prepare(
        'INSERT OR REPLACE INTO conflict_ignore (form_key, reason, created_ms) VALUES (?, ?, ?)',
      ).run(formKey, reason ?? null, Date.now())
    } else {
      db.prepare('DELETE FROM conflict_ignore WHERE form_key = ?').run(formKey)
    }
  })
}
