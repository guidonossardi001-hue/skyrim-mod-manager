// Build modlist_catalog rows from a parsed Vortex collections backup. The backup's `deduped`
// array is the de-duplicated, cross-collection-merged modlist (~4568 mods) — the "compatible"
// set the download/mass-sync pipeline already uses. This maps it into the curated-catalog row
// shape so the Catalog page can show the full modlist, not just the ~122 bundled essentials.
// The mapping/filtering (buildCatalogRowsFromBackup) is pure & Electron-free. The dedupe helper
// operates on the SqliteDb interface (type-only import) so it stays unit-testable with node:sqlite.
import type { SqliteDb } from '../db/sqlite'

// Marker written into modlist_catalog.notes for every Vortex-imported row. Used to tell a
// Vortex-origin row (sparse metadata, AUTHORITATIVE Nexus id) from a curated seed row.
export const VORTEX_IMPORT_NOTE = 'Importato dal backup Vortex'

export interface VortexBackupMod {
  modId?: number
  fileId?: number
  name?: string
  fileSize?: number
  optional?: boolean
  phase?: number
  collection?: string
}

export interface CatalogRow {
  nexus_id: number
  name: string
  category: string // NOT NULL in modlist_catalog
  subcategory: string | null
  priority_order: number
  required: number
  description: string | null
  author: string | null
  tags: string
  size_mb: number
  has_it_translation: number
  notes: string | null
  conflicts_with: string
  requires: string
}

/**
 * Map a parsed backup's `deduped` list to catalog rows. Keeps only well-formed mods (positive
 * integer modId + non-empty name), de-duplicated by modId (first wins). category = the source
 * collection name so the Catalog category filter is meaningful; priority_order is banded at 1000+
 * so imported mods sort AFTER the curated essentials (which use lower values).
 */
export function buildCatalogRowsFromBackup(backup: unknown): CatalogRow[] {
  const b = backup as { deduped?: unknown } | null
  const arr = Array.isArray(b?.deduped) ? (b!.deduped as VortexBackupMod[]) : []
  const seen = new Set<number>()
  const rows: CatalogRow[] = []
  for (const m of arr) {
    const id = m?.modId
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue
    if (typeof m?.name !== 'string' || !m.name.trim()) continue
    if (seen.has(id)) continue
    seen.add(id)
    const phase = Number.isInteger(m.phase) ? (m.phase as number) : 0
    const sizeBytes = typeof m.fileSize === 'number' && m.fileSize > 0 ? m.fileSize : 0
    rows.push({
      nexus_id: id,
      name: m.name.trim().slice(0, 300),
      category: (typeof m.collection === 'string' && m.collection.trim()) || 'Vortex',
      subcategory: null,
      priority_order: 1000 + phase,
      required: 0,
      description: null,
      author: null,
      tags: '[]',
      size_mb: Math.round(sizeBytes / (1024 * 1024)),
      has_it_translation: 0,
      notes: `${VORTEX_IMPORT_NOTE}${typeof m.collection === 'string' && m.collection ? ` (${m.collection})` : ''}`,
      conflicts_with: '[]',
      requires: '[]',
    })
  }
  return rows
}

/**
 * Remove cross-source name duplicates: a curated seed row and a Vortex-imported row that share a
 * name are the SAME mod, but the seed's hand-authored nexus_id is often a placeholder (e.g. SkyUI
 * seed#1137 vs the real #12604) while the Vortex id comes from a real install and is authoritative
 * for downloads. So drop the CURATED row and keep the Vortex one. Within-Vortex name collisions
 * (generic file names like "Main File" across genuinely distinct mods) are deliberately left alone.
 * Returns the number of duplicate rows removed.
 */
export function removeVortexNameDuplicates(db: SqliteDb): number {
  // Normalize names in JS (case + full internal-whitespace collapse) — SQLite's trim() can't
  // collapse internal runs, and the collision detection must match the import-time normalization.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const isVortex = (notes: string | null) => !!notes && notes.startsWith(VORTEX_IMPORT_NOTE)
  const rows = db.prepare('SELECT id, name, notes FROM modlist_catalog').all() as {
    id: number
    name: string
    notes: string | null
  }[]
  const vortexNames = new Set<string>()
  for (const r of rows) if (isVortex(r.notes)) vortexNames.add(norm(r.name))
  const toDelete = rows.filter((r) => !isVortex(r.notes) && vortexNames.has(norm(r.name)))
  if (!toDelete.length) return 0
  const del = db.prepare('DELETE FROM modlist_catalog WHERE id = ?')
  for (const r of toDelete) del.run(r.id)
  return toDelete.length
}
