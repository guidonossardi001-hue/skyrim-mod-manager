import { type SqliteDb, withTransaction } from '../db/sqlite'
import type { ChangesetRow } from './diff'

// The delta journal: persists the changeset, gates the final commit, and recovers
// after a crash. All state lives in delta_changeset.status so an interrupted apply
// is resumable. The installed_snapshot is the SINGLE source of truth for the
// from-side identity (fixes A2): mods.version is only advanced inside the gated
// final commit, never per-mod mid-flight.

export type RowStatus = 'pending' | 'downloading' | 'installing' | 'applied' | 'failed' | 'skipped'

export interface ChangesetMeta {
  profileId: number
  fromReleaseId: number | null
  toReleaseId: number
}

export interface DeltaRow {
  id: number
  profile_id: number
  to_release_id: number
  nexus_id: number
  change_type: string
  to_version: string | null
  to_file_id: number | null
  to_file_name: string | null
  to_file_hash: string | null
  to_download_url: string | null
  to_load_order: number | null
  status: RowStatus
}

// ── Record / recheck (fixes A1) ───────────────────────────────────────────────
// Replaces the ENTIRE open changeset for (profile, to_release) — delete every row
// regardless of status, then insert the freshly computed diff. This makes recheck
// after a partial/failed apply idempotent and impossible to hit a UNIQUE clash.
export function recordChangeset(db: SqliteDb, meta: ChangesetMeta, rows: ChangesetRow[]): number {
  return withTransaction(db, () => {
    db.prepare('DELETE FROM delta_changeset WHERE profile_id=? AND to_release_id=?').run(
      meta.profileId,
      meta.toReleaseId,
    )
    const ins = db.prepare(`
      INSERT INTO delta_changeset
        (profile_id, from_release_id, to_release_id, nexus_id, change_type,
         from_version, to_version, from_file_hash, to_file_hash,
         to_file_id, to_file_name, to_download_url, from_load_order, to_load_order, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`)
    for (const r of rows) {
      ins.run(
        meta.profileId,
        meta.fromReleaseId,
        meta.toReleaseId,
        r.nexus_id,
        r.change_type,
        r.from_version,
        r.to_version,
        r.from_file_hash,
        r.to_file_hash,
        r.to_file_id,
        r.to_file_name,
        r.to_download_url,
        r.from_load_order,
        r.to_load_order,
      )
    }
    return rows.length
  })
}

export function listChangeset(
  db: SqliteDb,
  profileId: number,
  toReleaseId: number,
  statuses?: RowStatus[],
): DeltaRow[] {
  let sql = 'SELECT * FROM delta_changeset WHERE profile_id=? AND to_release_id=?'
  const params: unknown[] = [profileId, toReleaseId]
  if (statuses && statuses.length) {
    sql += ` AND status IN (${statuses.map(() => '?').join(',')})`
    params.push(...statuses)
  }
  sql += ' ORDER BY id ASC'
  return db.prepare(sql).all(...params) as DeltaRow[]
}

export function setRowStatus(
  db: SqliteDb,
  rowId: number,
  status: RowStatus,
  extra?: { downloadId?: number; error?: string },
): void {
  db.prepare(
    'UPDATE delta_changeset SET status=?, download_id=COALESCE(?, download_id), error=? WHERE id=?',
  ).run(status, extra?.downloadId ?? null, extra?.error ?? null, rowId)
}

/** True iff every row of the changeset is terminal-success (applied or skipped). */
export function allTerminalSuccess(db: SqliteDb, profileId: number, toReleaseId: number): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS pending FROM delta_changeset WHERE profile_id=? AND to_release_id=? AND status NOT IN ('applied','skipped')",
    )
    .get(profileId, toReleaseId) as { pending: number }
  return row.pending === 0
}

// ── Gated final commit (fixes A2) ─────────────────────────────────────────────
// Runs ONLY if every row is terminal-success. In ONE transaction it advances the
// installed_snapshot to equal the target release, derives mods.version/file ids
// from the release (single source of truth), applies reorders, and removes
// disappeared mods' snapshot rows. Either the whole profile moves to the new
// release or nothing does.
export interface FinalizeResult {
  committed: boolean
  reason?: string
  snapshotRows?: number
}

export function finalizeApply(db: SqliteDb, profileId: number, toReleaseId: number): FinalizeResult {
  if (!allTerminalSuccess(db, profileId, toReleaseId)) {
    return { committed: false, reason: 'changeset non completo (download/install ancora aperti o falliti)' }
  }

  const rows = listChangeset(db, profileId, toReleaseId)
  if (rows.length === 0) return { committed: true, snapshotRows: 0 }

  return withTransaction(db, () => {
    const findMod = db.prepare('SELECT id FROM mods WHERE profile_id=? AND nexus_id=?')
    const bumpMod = db.prepare(
      'UPDATE mods SET version=?, nexus_file_id=?, file_hash=?, priority=?, load_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    )
    const reorderMod = db.prepare(
      'UPDATE mods SET priority=?, load_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    )
    const upsertSnap = db.prepare(`
      INSERT INTO installed_snapshot (profile_id, release_id, nexus_id, mod_id, version, file_id, file_name, file_hash, load_order)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id, nexus_id) DO UPDATE SET
        release_id=excluded.release_id, mod_id=excluded.mod_id, version=excluded.version,
        file_id=excluded.file_id, file_name=excluded.file_name, file_hash=excluded.file_hash,
        load_order=excluded.load_order, applied_at=CURRENT_TIMESTAMP`)
    const delSnap = db.prepare('DELETE FROM installed_snapshot WHERE profile_id=? AND nexus_id=?')

    for (const r of rows) {
      if (r.status === 'skipped') continue
      const mod = findMod.get(profileId, r.nexus_id) as { id: number } | undefined
      const lo = r.to_load_order ?? 0

      if (r.change_type === 'removed') {
        delSnap.run(profileId, r.nexus_id)
        continue
      }
      if (r.change_type === 'reordered') {
        if (mod) reorderMod.run(lo, lo, mod.id)
        upsertSnap.run(
          profileId,
          toReleaseId,
          r.nexus_id,
          mod?.id ?? null,
          r.to_version,
          r.to_file_id,
          r.to_file_name,
          r.to_file_hash,
          lo,
        )
        continue
      }
      // added | changed → derive mods identity from the release (single source of truth)
      if (mod) bumpMod.run(r.to_version, r.to_file_id, r.to_file_hash, lo, lo, mod.id)
      upsertSnap.run(
        profileId,
        toReleaseId,
        r.nexus_id,
        mod?.id ?? null,
        r.to_version,
        r.to_file_id,
        r.to_file_name,
        r.to_file_hash,
        lo,
      )
    }

    db.prepare('DELETE FROM delta_changeset WHERE profile_id=? AND to_release_id=?').run(
      profileId,
      toReleaseId,
    )
    const count = (
      db.prepare('SELECT COUNT(*) c FROM installed_snapshot WHERE profile_id=?').get(profileId) as {
        c: number
      }
    ).c
    return { committed: true, snapshotRows: count }
  })
}

// ── Crash recovery (fixes A5) ─────────────────────────────────────────────────
// On startup, any changeset row left mid-flight (downloading/installing) is reset
// to 'pending' so the queue re-drives it; orphaned 'downloading' downloads are
// likewise reset. installed_snapshot is never advanced here — only finalizeApply,
// gated, can do that — so recovery can only ever resume or fail-safe, never
// half-commit.
export interface RecoveryResult {
  resetRows: number
  resetDownloads: number
}

export function recoverOnStartup(db: SqliteDb): RecoveryResult {
  return withTransaction(db, () => {
    const r1 = db
      .prepare("UPDATE delta_changeset SET status='pending' WHERE status IN ('downloading','installing')")
      .run()
    const r2 = db
      .prepare("UPDATE downloads SET status='pending', downloaded_size=0 WHERE status='downloading'")
      .run()
    return { resetRows: Number(r1.changes), resetDownloads: Number(r2.changes) }
  })
}
