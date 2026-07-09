import { statfs } from 'fs/promises'
import { dirname, resolve } from 'path'

// Disk-space pre-flight for heavy installs. Inspired by the Nolvus installer API,
// whose package model tracks DownloadSize / InstallationSize / ModsStorageSpace and
// refuses to start when the target volume is too small. We lack per-mod install
// sizes, so we estimate the peak footprint from the (compressed) archive size and
// block BEFORE extraction rather than failing cryptically mid-unpack on a multi-GB
// archive. Pure helpers are unit-tested; getFreeSpace is best-effort and fail-OPEN
// (a probe failure must never falsely block a legitimate install).

export interface SpaceAssessment {
  ok: boolean
  freeBytes: number
  requiredBytes: number // includes the safety margin
  shortfallBytes: number // 0 when ok
}

// A .7z/.zip expands well beyond its compressed size, and the archive + the extracted
// tree coexist on disk during install — hence a multiplier, plus fixed headroom.
export const EXTRACTION_FACTOR = 2.5
export const DEFAULT_MARGIN_BYTES = 512 * 1024 * 1024 // 512 MB

export function estimateInstallFootprint(archiveBytes: number, factor = EXTRACTION_FACTOR): number {
  return Math.ceil(Math.max(0, archiveBytes) * factor)
}

export function assessDiskSpace(opts: {
  requiredBytes: number
  freeBytes: number
  marginBytes?: number
}): SpaceAssessment {
  const margin = opts.marginBytes ?? DEFAULT_MARGIN_BYTES
  const required = Math.max(0, opts.requiredBytes) + margin
  const ok = opts.freeBytes >= required
  return {
    ok,
    freeBytes: opts.freeBytes,
    requiredBytes: required,
    shortfallBytes: ok ? 0 : required - opts.freeBytes,
  }
}

/** Free bytes on the volume containing `path`. Walks up to the first queryable
 *  ancestor (the dir may not exist yet); returns Infinity if nothing can be read. */
export async function getFreeSpace(path: string): Promise<number> {
  let p = resolve(path)
  for (let i = 0; i < 12; i++) {
    try {
      const s = await statfs(p)
      return s.bsize * s.bavail
    } catch {
      /* try the parent */
    }
    const parent = dirname(p)
    if (parent === p) break
    p = parent
  }
  return Infinity
}

export function formatBytes(n: number): string {
  if (!isFinite(n)) return '∞'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n,
    i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
  return `${s} ${units[i]}`
}
