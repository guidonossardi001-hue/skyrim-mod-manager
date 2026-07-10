import type Database from 'better-sqlite3'
import type Store from 'electron-store'

/**
 * Resolve the active profile id with a stable fallback chain: the stored
 * `activeProfileId`, else the oldest profile row, else 1. Single-sourced so the
 * "no profile selected yet" policy stays identical across the launch, compatibility
 * and nxm:// paths.
 */
export function resolveActiveProfileId(db: Database.Database, store: Store): number {
  return (
    (store.get('activeProfileId') as number | undefined) ??
    (
      db.prepare('SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1').get() as
        | { id: number }
        | undefined
    )?.id ??
    1
  )
}
