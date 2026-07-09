import { type SqliteDb, withTransaction } from '../db/sqlite'

// Baseline seeding for the delta engine. The installed_snapshot is the single
// source of truth for the "from" side of a delta diff, but until now it was only
// ever written by finalizeApply (i.e. AFTER a delta apply). A modlist installed
// the normal way (download → extract → mods.is_installed=1) therefore had no
// baseline, so check() saw every release mod as "added" and real incremental
// updates were impossible.
//
// syncInstalledSnapshot reconciles installed_snapshot with the live `mods` table:
// it captures version / file identity / load order of every installed,
// nexus-identified mod, and drops snapshot rows for mods no longer installed.
// Idempotent and persisted. It PRESERVES any existing release_id (a row that came
// from a delta keeps its provenance) by not touching that column on update.
//
// Note: mods without a nexus_id (e.g. some Wabbajack imports) cannot be tracked
// by the (profile_id, nexus_id) identity and are intentionally excluded.

export interface SnapshotSyncResult {
  rows: number
  added: number
  removed: number
}

interface ModRow {
  id: number
  nexus_id: number
  version: string | null
  nexus_file_id: number | null
  file_hash: string | null
  load_order: number | null
  priority: number | null
}

export function syncInstalledSnapshot(db: SqliteDb, profileId: number): SnapshotSyncResult {
  return withTransaction(db, () => {
    const mods = db
      .prepare(
        `SELECT id, nexus_id, version, nexus_file_id, file_hash, load_order, priority
       FROM mods WHERE profile_id=? AND is_installed=1 AND nexus_id IS NOT NULL`,
      )
      .all(profileId) as ModRow[]

    const existing = new Set(
      (
        db.prepare('SELECT nexus_id FROM installed_snapshot WHERE profile_id=?').all(profileId) as {
          nexus_id: number
        }[]
      ).map((r) => r.nexus_id),
    )

    // release_id is omitted from the UPDATE clause on purpose → existing provenance survives.
    const upsert = db.prepare(`
      INSERT INTO installed_snapshot (profile_id, release_id, nexus_id, mod_id, version, file_id, file_name, file_hash, load_order)
      VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(profile_id, nexus_id) DO UPDATE SET
        mod_id=excluded.mod_id, version=excluded.version, file_id=excluded.file_id,
        file_hash=excluded.file_hash, load_order=excluded.load_order, applied_at=CURRENT_TIMESTAMP`)

    const installed = new Set<number>()
    let added = 0
    for (const m of mods) {
      const lo = m.load_order ?? m.priority ?? 0
      upsert.run(profileId, m.nexus_id, m.id, m.version, m.nexus_file_id, m.file_hash, lo)
      installed.add(m.nexus_id)
      if (!existing.has(m.nexus_id)) added++
    }

    // Reconcile removals: a mod uninstalled locally drops out of the baseline.
    const del = db.prepare('DELETE FROM installed_snapshot WHERE profile_id=? AND nexus_id=?')
    let removed = 0
    for (const nx of existing)
      if (!installed.has(nx)) {
        del.run(profileId, nx)
        removed++
      }

    const rows = (
      db.prepare('SELECT COUNT(*) c FROM installed_snapshot WHERE profile_id=?').get(profileId) as {
        c: number
      }
    ).c
    return { rows, added, removed }
  })
}
