// Build modlist_catalog rows from a parsed Vortex collections backup. The backup's `deduped`
// array is the de-duplicated, cross-collection-merged modlist (~4568 mods) — the "compatible"
// set the download/mass-sync pipeline already uses. This maps it into the curated-catalog row
// shape so the Catalog page can show the full modlist, not just the ~122 bundled essentials.
// Pure & Electron-free so the mapping/filtering is unit-testable in isolation.

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
      notes: `Importato dal backup Vortex${typeof m.collection === 'string' && m.collection ? ` (${m.collection})` : ''}`,
      conflicts_with: '[]',
      requires: '[]',
    })
  }
  return rows
}
