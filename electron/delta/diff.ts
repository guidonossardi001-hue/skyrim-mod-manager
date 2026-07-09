import { isNewer } from './version'

// Pure changeset computation: the set-difference between the profile's installed
// snapshot and the target catalog release. Hash-primary (file_hash), with the
// tolerant version comparator only as a fallback when a hash is unavailable.

export type ChangeType = 'added' | 'removed' | 'changed' | 'reordered'

export interface SnapshotRow {
  nexus_id: number
  version: string | null
  file_id: number | null
  file_hash: string | null
  load_order: number
}

export interface ReleaseRow {
  nexus_id: number
  name: string
  version: string | null
  file_id: number | null
  file_name: string | null
  file_hash: string | null
  download_url: string | null
  priority_order: number
}

export interface ChangesetRow {
  nexus_id: number
  change_type: ChangeType
  from_version: string | null
  to_version: string | null
  from_file_hash: string | null
  to_file_hash: string | null
  to_file_id: number | null
  to_file_name: string | null
  to_download_url: string | null
  from_load_order: number | null
  to_load_order: number | null
}

function archiveChanged(s: SnapshotRow, r: ReleaseRow): boolean {
  // Prefer content identity. Only fall back to (tolerant) version ordering when a
  // hash is missing on either side — never let a bad version string force a throw.
  if (s.file_hash && r.file_hash) return s.file_hash !== r.file_hash
  return isNewer(r.version, s.version)
}

export function computeChangeset(snapshot: SnapshotRow[], release: ReleaseRow[]): ChangesetRow[] {
  const snapByNexus = new Map(snapshot.map((s) => [s.nexus_id, s]))
  const relByNexus = new Map(release.map((r) => [r.nexus_id, r]))
  const out: ChangesetRow[] = []

  for (const r of release) {
    const s = snapByNexus.get(r.nexus_id)
    if (!s) {
      out.push({
        nexus_id: r.nexus_id,
        change_type: 'added',
        from_version: null,
        to_version: r.version,
        from_file_hash: null,
        to_file_hash: r.file_hash,
        to_file_id: r.file_id,
        to_file_name: r.file_name,
        to_download_url: r.download_url,
        from_load_order: null,
        to_load_order: r.priority_order,
      })
      continue
    }
    if (archiveChanged(s, r)) {
      out.push({
        nexus_id: r.nexus_id,
        change_type: 'changed',
        from_version: s.version,
        to_version: r.version,
        from_file_hash: s.file_hash,
        to_file_hash: r.file_hash,
        to_file_id: r.file_id,
        to_file_name: r.file_name,
        to_download_url: r.download_url,
        from_load_order: s.load_order,
        to_load_order: r.priority_order,
      })
    } else if ((s.load_order ?? 0) !== (r.priority_order ?? 0)) {
      out.push({
        nexus_id: r.nexus_id,
        change_type: 'reordered',
        from_version: s.version,
        to_version: r.version,
        from_file_hash: s.file_hash,
        to_file_hash: r.file_hash,
        to_file_id: r.file_id,
        to_file_name: r.file_name,
        to_download_url: r.download_url,
        from_load_order: s.load_order,
        to_load_order: r.priority_order,
      })
    }
  }

  for (const s of snapshot) {
    if (!relByNexus.has(s.nexus_id)) {
      out.push({
        nexus_id: s.nexus_id,
        change_type: 'removed',
        from_version: s.version,
        to_version: null,
        from_file_hash: s.file_hash,
        to_file_hash: null,
        to_file_id: null,
        to_file_name: null,
        to_download_url: null,
        from_load_order: s.load_order,
        to_load_order: null,
      })
    }
  }

  return out
}

export function summarizeChangeset(rows: ChangesetRow[]): Record<ChangeType, number> {
  const counts: Record<ChangeType, number> = { added: 0, removed: 0, changed: 0, reordered: 0 }
  for (const r of rows) counts[r.change_type]++
  return counts
}
