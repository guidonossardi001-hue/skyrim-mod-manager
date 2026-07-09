import { createHash } from 'crypto'
import type { SqliteDb } from '../db/sqlite'
import { withTransaction } from '../db/sqlite'
import { canonicalJSON } from './canonicalJson'
import { verifyManifest, DEFAULT_ALLOWED_HOSTS, type SignedManifest, type ManifestBody } from './manifest'
import { computeChangeset, summarizeChangeset, type SnapshotRow, type ReleaseRow } from './diff'
import {
  recordChangeset,
  listChangeset,
  setRowStatus,
  finalizeApply,
  recoverOnStartup,
  type DeltaRow,
} from './journal'
import { syncInstalledSnapshot, type SnapshotSyncResult } from './snapshot'

// Electron-free delta engine. All ingest/verify/stage/commit/recover logic lives
// here against the SqliteDb interface so the FULL pipeline is unit-testable with a
// real keypair + node:sqlite. engine.ts is only the thin ipcMain wrapper.

export interface DeltaServiceOptions {
  publicKeyPem: string
  allowedHosts?: RegExp[]
  enqueueDownload?: (downloadId: number) => void
  log?: (level: 'info' | 'warn', msg: string) => void
}

export interface IngestResult {
  success: boolean
  releaseId?: number
  reused?: boolean
  error?: string
}
export interface CheckResult {
  ok: boolean
  toReleaseId?: number
  counts?: Record<string, number>
  error?: string
}

export interface DeltaUpdate {
  nexus_id: number
  name: string | null
  from_version: string | null
  to_version: string | null
  change_type: string
}
export interface CheckUpdatesResult {
  ok: boolean
  toReleaseId?: number
  snapshotRows: number
  updates: DeltaUpdate[]
  counts: Record<string, number>
  error?: string
}

export class DeltaService {
  private allowedHosts: RegExp[]
  constructor(
    private db: SqliteDb,
    private opts: DeltaServiceOptions,
  ) {
    this.allowedHosts = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
  }
  private log(level: 'info' | 'warn', msg: string) {
    this.opts.log?.(level, msg)
  }

  private lastCounter(): number {
    return (
      this.db.prepare('SELECT COALESCE(MAX(release_counter),0) AS c FROM catalog_release').get() as {
        c: number
      }
    ).c
  }

  /** ingest = verify (trust boundary) → store release atomically. */
  ingest(signed: SignedManifest): IngestResult {
    // Idempotent re-ingest: a manifest we already accepted (same content hash) is a
    // no-op and must NOT be treated as a replay just because its counter equals the
    // last accepted one. Dedup BEFORE the strict monotonic counter check.
    const incomingHash = (() => {
      try {
        return createHash('sha256').update(canonicalJSON(signed?.manifest)).digest('hex')
      } catch {
        return null
      }
    })()
    if (incomingHash) {
      const known = this.db
        .prepare('SELECT id FROM catalog_release WHERE manifest_hash=?')
        .get(incomingHash) as { id: number } | undefined
      if (known) return { success: true, releaseId: known.id, reused: true }
    }

    const res = verifyManifest(signed, {
      publicKeyPem: this.opts.publicKeyPem,
      lastCounter: this.lastCounter(),
      allowedHosts: this.allowedHosts,
    })
    if (!res.ok || !res.manifest) {
      this.log('warn', `manifest rifiutato: ${res.error}`)
      return { success: false, error: res.error }
    }
    const m: ManifestBody = res.manifest
    const manifestHash = createHash('sha256').update(canonicalJSON(m)).digest('hex')

    const releaseId = withTransaction(this.db, () => {
      const r = this.db
        .prepare(
          'INSERT INTO catalog_release (release_tag, release_counter, manifest_hash, published_at) VALUES (?,?,?,?)',
        )
        .run(m.release_tag, m.release_counter, manifestHash, m.published_at)
      const id = Number(r.lastInsertRowid)
      const ins = this.db.prepare(
        'INSERT INTO catalog_release_mod (release_id, nexus_id, name, category, priority_order, version, file_id, file_name, file_hash, download_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      for (const mod of m.mods) {
        ins.run(
          id,
          mod.nexus_id,
          mod.name,
          mod.category ?? null,
          mod.priority_order ?? 999,
          mod.version,
          mod.file_id,
          mod.file_name,
          mod.file_hash,
          mod.download_url ?? null,
        )
      }
      return id
    })
    this.log('info', `release ingerita #${releaseId} (counter ${m.release_counter}, ${m.mods.length} mod)`)
    return { success: true, releaseId, reused: false }
  }

  /** check = diff installed_snapshot vs latest release → persist changeset (stage). */
  check(profileId: number): CheckResult {
    const rel = this.db.prepare('SELECT id FROM catalog_release ORDER BY id DESC LIMIT 1').get() as
      { id: number } | undefined
    if (!rel) return { ok: false, error: 'nessuna release ingerita' }
    const toReleaseId = rel.id
    const snapshot = this.db
      .prepare(
        'SELECT nexus_id, version, file_id, file_hash, load_order FROM installed_snapshot WHERE profile_id=?',
      )
      .all(profileId) as SnapshotRow[]
    const release = this.db
      .prepare(
        'SELECT nexus_id, name, version, file_id, file_name, file_hash, download_url, priority_order FROM catalog_release_mod WHERE release_id=?',
      )
      .all(toReleaseId) as ReleaseRow[]
    const fromReleaseId =
      (
        this.db
          .prepare('SELECT release_id FROM installed_snapshot WHERE profile_id=? LIMIT 1')
          .get(profileId) as { release_id: number } | undefined
      )?.release_id ?? null
    const changeset = computeChangeset(snapshot, release)
    recordChangeset(this.db, { profileId, fromReleaseId, toReleaseId }, changeset)
    return { ok: true, toReleaseId, counts: summarizeChangeset(changeset) }
  }

  /** Seed/reconcile the installed_snapshot baseline from the live mods table. */
  syncSnapshot(profileId: number): SnapshotSyncResult {
    return syncInstalledSnapshot(this.db, profileId)
  }

  private snapshotCount(profileId: number): number {
    return (
      this.db.prepare('SELECT COUNT(*) c FROM installed_snapshot WHERE profile_id=?').get(profileId) as {
        c: number
      }
    ).c
  }

  /**
   * Real "check for updates": refresh the baseline snapshot from what is actually
   * installed, diff it against the latest ingested (signed) release, and return the
   * per-mod version drift. The changeset is staged (recorded) so the same result can
   * be applied via apply()/finalize() — no mock, persistent end to end.
   */
  checkUpdates(profileId: number): CheckUpdatesResult {
    this.syncSnapshot(profileId)
    const rel = this.db.prepare('SELECT id FROM catalog_release ORDER BY id DESC LIMIT 1').get() as
      { id: number } | undefined
    if (!rel) {
      return {
        ok: false,
        error: 'nessun manifest remoto ingerito',
        snapshotRows: this.snapshotCount(profileId),
        updates: [],
        counts: {},
      }
    }
    const res = this.check(profileId) // records the staged changeset against the latest release
    if (!res.ok || res.toReleaseId == null) {
      return {
        ok: false,
        error: res.error ?? 'check fallito',
        snapshotRows: this.snapshotCount(profileId),
        updates: [],
        counts: {},
      }
    }
    const updates = this.db
      .prepare(
        `SELECT dc.nexus_id, dc.change_type, dc.from_version, dc.to_version, crm.name
       FROM delta_changeset dc
       LEFT JOIN catalog_release_mod crm ON crm.release_id = dc.to_release_id AND crm.nexus_id = dc.nexus_id
       WHERE dc.profile_id=? AND dc.to_release_id=? AND dc.change_type IN ('added','changed')
       ORDER BY dc.id ASC`,
      )
      .all(profileId, res.toReleaseId) as DeltaUpdate[]
    return {
      ok: true,
      toReleaseId: res.toReleaseId,
      snapshotRows: this.snapshotCount(profileId),
      updates,
      counts: res.counts ?? {},
    }
  }

  list(profileId: number, toReleaseId: number): DeltaRow[] {
    return listChangeset(this.db, profileId, toReleaseId)
  }

  /** apply = create downloads for added/changed (queue drives them), mark removed/reordered done. */
  apply(profileId: number, toReleaseId: number): { queued: number; total: number } {
    const rows = listChangeset(this.db, profileId, toReleaseId, ['pending', 'failed'])
    let queued = 0
    for (const r of rows) {
      if (r.change_type === 'removed' || r.change_type === 'reordered') {
        setRowStatus(this.db, r.id, 'applied')
        continue
      }
      let mod = this.db
        .prepare('SELECT id FROM mods WHERE profile_id=? AND nexus_id=?')
        .get(profileId, r.nexus_id) as { id: number } | undefined
      if (!mod) {
        const res = this.db
          .prepare(
            'INSERT INTO mods (profile_id, nexus_id, name, version, category, is_enabled, is_installed, priority, load_order) VALUES (?,?,?,?,?,1,0,?,?)',
          )
          .run(
            profileId,
            r.nexus_id,
            r.to_file_name ?? `mod_${r.nexus_id}`,
            r.to_version,
            'other',
            r.to_load_order ?? 999,
            r.to_load_order ?? 999,
          )
        mod = { id: Number(res.lastInsertRowid) }
      }
      const dl = this.db
        .prepare(
          "INSERT INTO downloads (mod_id, profile_id, nexus_id, file_id, name, url, status) VALUES (?,?,?,?,?,?, 'pending')",
        )
        .run(
          mod.id,
          profileId,
          r.nexus_id,
          r.to_file_id,
          r.to_file_name ?? `mod_${r.nexus_id}`,
          r.to_download_url ?? null,
        )
      const downloadId = Number(dl.lastInsertRowid)
      setRowStatus(this.db, r.id, 'downloading', { downloadId })
      this.opts.enqueueDownload?.(downloadId)
      queued++
    }
    return { queued, total: rows.length }
  }

  finalize(profileId: number, toReleaseId: number) {
    return finalizeApply(this.db, profileId, toReleaseId)
  }
  recover() {
    return recoverOnStartup(this.db)
  }

  /** Test/integration helper: mark every open row of a changeset as applied (as if all downloads+installs succeeded). */
  markAllApplied(profileId: number, toReleaseId: number): void {
    for (const r of listChangeset(this.db, profileId, toReleaseId)) {
      if (r.status !== 'applied' && r.status !== 'skipped') setRowStatus(this.db, r.id, 'applied')
    }
  }
}
