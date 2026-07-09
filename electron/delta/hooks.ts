import type { SqliteDb } from '../db/sqlite'
import { setRowStatus, finalizeApply } from './journal'

// Called by the download/install pipeline when an archive tied to a delta finishes.
// Advances the matching changeset row, then attempts the gated finalize (which only
// commits when EVERY row is terminal-success).

export function onDeltaDownloadComplete(db: SqliteDb, downloadId: number): { committed: boolean } | null {
  const row = db
    .prepare('SELECT id, profile_id, to_release_id FROM delta_changeset WHERE download_id=?')
    .get(downloadId) as { id: number; profile_id: number; to_release_id: number } | undefined
  if (!row) return null
  setRowStatus(db, row.id, 'applied')
  return finalizeApply(db, row.profile_id, row.to_release_id)
}

export function onDeltaDownloadFailed(db: SqliteDb, downloadId: number, error: string): void {
  const row = db.prepare('SELECT id FROM delta_changeset WHERE download_id=?').get(downloadId) as
    { id: number } | undefined
  if (row) setRowStatus(db, row.id, 'failed', { error })
}
