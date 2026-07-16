import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs'
import { rmSync } from 'fs'
import { join } from 'path'
import { gzipSync, gunzipSync } from 'zlib'
import type { SqliteDb } from '../db/sqlite'
import { withTransaction } from '../db/sqlite'
import { atomicWriteFile, writeChecksumSidecar, verifyChecksum, snapshotDatabase } from './snapshot'

// Electron-free backup core (testable with node:sqlite + a temp dir). Hardens the
// previous non-atomic JSON dump: atomic write + checksum sidecar (M2), restore
// refuses a corrupt point, and an optional whole-DB VACUUM INTO snapshot (C2).
// LOCKSTEP: BOUND_MOD_COLUMNS is the single source for the writable mods columns —
// includes the delta identity columns so restores never silently drop them.
//
// T11 (2026-07-17): the JSON payload is gzip-compressed (typically 80%+ smaller —
// meaningful when dozens of backups accumulate on a near-full disk). New backups
// are written as `.json.gz`; the DB snapshot (rare, manual-recovery artifact) is
// left plain so a human can copy it back without decompressing first. `listBackups`
// and `restoreProfileBackup` still recognize legacy plain `.json` files by gzip
// magic-byte sniffing — no migration needed, old backups keep working.

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

export const BOUND_MOD_COLUMNS = [
  'nexus_id',
  'name',
  'version',
  'author',
  'category',
  'description',
  'file_size',
  'install_path',
  'is_enabled',
  'is_installed',
  'load_order',
  'priority',
  'tags',
  'conflicts',
  'requires',
  'translation_it',
  'nexus_url',
  'thumbnail_url',
  'nexus_file_id',
  'file_hash',
]

export interface BackupEntry {
  name: string
  path: string
  size: number
  date: string
  valid: boolean
}
export interface CreateResult {
  success: boolean
  name: string
  path: string
  size: number
  sha256: string
  dbSnapshotPath?: string
}
export interface RestoreResult {
  success: boolean
  restored?: number
  error?: string
}

function sanitize(s: string): string {
  return s
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/[:.]/g, '-')
    .slice(0, 120)
}

export async function createProfileBackup(
  db: SqliteDb,
  backupDir: string,
  profileId: number,
  label?: string,
  opts?: { snapshotDb?: boolean },
): Promise<CreateResult> {
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const name = sanitize(label ? `${label}_${ts}` : `backup_profile${profileId}_${ts}`)
  const destPath = join(backupDir, `${name}.json.gz`)

  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(profileId)
  const mods = db.prepare('SELECT * FROM mods WHERE profile_id=?').all(profileId)
  const payload = JSON.stringify(
    { version: '1.1', profile, mods, createdAt: new Date().toISOString() },
    null,
    2,
  )
  const compressed = gzipSync(payload)

  atomicWriteFile(destPath, compressed) // power-loss safe (temp + fsync + rename)
  const sha256 = await writeChecksumSidecar(destPath) // detectable corruption

  let dbSnapshotPath: string | undefined
  if (opts?.snapshotDb) {
    dbSnapshotPath = join(backupDir, `${name}.db`)
    snapshotDatabase(db, dbSnapshotPath) // whole-DB rollback point (incl. versioning tables)
  }
  return { success: true, name, path: destPath, size: compressed.length, sha256, dbSnapshotPath }
}

export async function listBackups(backupDir: string): Promise<BackupEntry[]> {
  if (!existsSync(backupDir)) return []
  const out: BackupEntry[] = []
  // `.json.gz` = nuovi backup compressi; `.json` = legacy (pre-T11), ancora leggibili.
  for (const f of readdirSync(backupDir).filter((x) => x.endsWith('.json.gz') || x.endsWith('.json'))) {
    const p = join(backupDir, f)
    const s = statSync(p)
    out.push({
      name: f.replace(/\.json(\.gz)?$/, ''),
      path: p,
      size: s.size,
      date: s.mtime.toISOString(),
      valid: await verifyChecksum(p),
    })
  }
  return out.sort((a, b) => b.date.localeCompare(a.date))
}

/** Legge un backup gestendo trasparentemente sia `.json.gz` (nuovi) che `.json` in
 *  chiaro (legacy): sniffing sui magic byte gzip, mai sull'estensione del file. */
function readBackupPayload(backupPath: string): string {
  const raw = readFileSync(backupPath)
  return raw.length >= 2 && raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1]
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8')
}

export async function restoreProfileBackup(
  db: SqliteDb,
  backupPath: string,
  targetProfileId: number,
): Promise<RestoreResult> {
  // Refuse a corrupt restore point rather than trusting it (M2).
  if (existsSync(`${backupPath}.sha256`) && !(await verifyChecksum(backupPath))) {
    return { success: false, error: 'Backup corrotto (checksum non corrispondente) — ripristino annullato' }
  }
  let payload: { mods?: Record<string, unknown>[] }
  try {
    payload = JSON.parse(readBackupPayload(backupPath))
  } catch {
    return { success: false, error: 'Backup non leggibile (JSON/gzip non valido)' }
  }
  const mods = payload.mods ?? []

  const cols = ['profile_id', ...BOUND_MOD_COLUMNS]
  const insert = db.prepare(
    `INSERT INTO mods (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
  return withTransaction(db, () => {
    db.prepare('DELETE FROM mods WHERE profile_id=?').run(targetProfileId)
    for (const mod of mods) {
      insert.run(targetProfileId, ...BOUND_MOD_COLUMNS.map((c) => mod[c] ?? null))
    }
    return { success: true, restored: mods.length }
  })
}

export function deleteBackup(backupPath: string): void {
  const base = backupPath.replace(/\.json(\.gz)?$/, '')
  const targets = [`${base}.json`, `${base}.json.gz`, `${base}.db`]
  for (const p of [...targets, ...targets.map((t) => `${t}.sha256`)]) {
    try {
      if (existsSync(p)) rmSync(p, { force: true })
    } catch {
      /* ignore */
    }
  }
}
