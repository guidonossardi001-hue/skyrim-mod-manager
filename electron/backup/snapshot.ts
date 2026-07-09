import { createHash } from 'crypto'
import {
  createReadStream,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'fs'
import type { SqliteDb } from '../db/sqlite'

// Hardened backup primitives.
//  - snapshotDatabase: a CONSISTENT, whole-database copy via VACUUM INTO — captures
//    every table (incl. installed_snapshot / delta_changeset / catalog_release), not
//    just the mods JSON (fixes C2). The right rollback point for a delta.
//  - atomicWriteFile + checksum sidecar: power-loss-safe writes; a half-written
//    restore point is detectable and refused instead of silently trusted (M2).
//  - sha256File / verifyFileHash: streaming archive hashing for pre-extraction
//    integrity (fixes C3) — large archives are hashed without loading into memory.

/** Consistent whole-DB snapshot. Overwrites destPath if present. */
export function snapshotDatabase(db: SqliteDb, destPath: string): void {
  if (existsSync(destPath)) unlinkSync(destPath)
  // VACUUM INTO ? is supported with a bound parameter (SQLite >= 3.27) → no path escaping.
  db.prepare('VACUUM INTO ?').run(destPath)
}

/** Atomic write: temp file + fsync + rename (rename is atomic on the same volume). */
export function atomicWriteFile(destPath: string, data: string | Buffer): void {
  const tmp = `${destPath}.tmp`
  writeFileSync(tmp, data)
  const fd = openSync(tmp, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, destPath)
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Write a `<file>.sha256` sidecar; returns the digest. */
export async function writeChecksumSidecar(filePath: string): Promise<string> {
  const digest = await sha256File(filePath)
  atomicWriteFile(`${filePath}.sha256`, digest)
  return digest
}

/** True iff the sidecar exists and matches the file's current content (M2). */
export async function verifyChecksum(filePath: string): Promise<boolean> {
  const sidecar = `${filePath}.sha256`
  if (!existsSync(filePath) || !existsSync(sidecar)) return false
  const expected = readFileSync(sidecar, 'utf8').trim()
  const actual = await sha256File(filePath)
  return expected.length > 0 && expected === actual
}

/** Pre-extraction archive integrity gate (C3). Streaming, memory-safe. */
export async function verifyFileHash(archivePath: string, expectedSha256: string): Promise<boolean> {
  if (!expectedSha256 || !existsSync(archivePath)) return false
  const actual = await sha256File(archivePath)
  return actual.toLowerCase() === expectedSha256.toLowerCase()
}
