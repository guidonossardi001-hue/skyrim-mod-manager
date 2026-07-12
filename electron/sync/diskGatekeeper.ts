// Pre-flight disk gatekeeper (PRECHECK-02). Before the mass-installer starts the TaskQueue loop we
// must know the WHOLE download footprint, not just the mods the user hand-picked: a selected mod can
// pull in required frameworks/masters via the dependency graph. So the required-space estimate is
// built over the resolveInstallPlan output (targets + transitive dependencies), not the raw
// selection — otherwise an un-listed dependency's bytes go uncounted and the disk fills mid-install.
//
// Everything here is PURE (db reads and free-space go through the caller): the size aggregation and
// the fail-closed gate are unit-testable without a filesystem, a real catalog, or a real volume.

import { resolveInstallPlan } from '../catalog/dependencies'
import { resolveMods, DEFAULT_TEXTURE_PROFILE, type TextureProfile } from './textureProfile'
import {
  modDestDir,
  stockGameModsDir,
  computeDiskPreflight,
  MIN_FREE_MARGIN_BYTES,
  type SyncMod,
  type DiskPreflight,
} from './massSync'
import type { SqliteDb } from '../db/sqlite'

/** A fileSize we can trust as a lower bound: a finite, strictly-positive number. Anything else
 *  (undefined, 0, negative, NaN from an untrusted backup) is "unknown", NOT zero cost. */
function trustedSize(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Headroom for temporary extraction space, per PRECHECK-02: free must clear required × this. */
export const DISK_BUFFER_FACTOR = 1.15

export interface RequiredSpace {
  targetIds: number[] // the mods actually asked to install (their nexus_id/modId)
  plannedIds: number[] // resolveInstallPlan order (targets + deps), already minus installed
  extraDepIds: number[] // ids the plan added that were NOT in the selection (auto-pulled deps)
  // A mod THIS run will actually download (a target) whose size is unknown (missing/≤0/NaN). This is
  // real doubt: its bytes can't be counted, so the gate must BLOCK rather than under-reserve.
  unsizedTargetIds: number[]
  // A pulled-in catalog dependency with no known size that this run does NOT download (runMassSync
  // installs only the selection). Informational — it does not affect this run's disk footprint.
  unknownDepIds: number[]
  // Phase-B translation archives this run WILL download whose size is unknown. Informational, NOT a
  // block: translations are fail-soft (a failed overlay never aborts the run) and tiny next to the
  // base archives, so blocking the whole mass-install on a missing translation size would cost more
  // than the few uncounted MB — but the doubt is surfaced instead of silently dropped.
  unsizedTranslationIds: number[]
  usedDependencyGraph: boolean // false ⇒ catalog absent/empty, fell back to targets-not-installed
  requiredBytes: number // Σ profile-selected archive bytes of planned-not-installed (+ translations)
  requiredBytes4K: number // same sum at the 4K profile (baseline for the saving)
  savingBytes: number // requiredBytes4K − requiredBytes (>0 when a lighter profile is active)
  translationBytes: number // portion of requiredBytes attributable to Phase-B ITA translations
  profile: TextureProfile
}

/**
 * Sum the download size of an install plan. The plan is the transitive closure of `targetIds` over
 * the dependency catalog (resolveInstallPlan) minus everything already extracted on disk. Sizes come
 * from the sizing catalog `mods` resolved to the active texture profile (`resolveMods`), so a 2K
 * profile estimates the lighter 2K variant and reports the GB saved vs 4K. Dependencies the plan
 * pulls in that have no entry in `mods` (unknown archive) are surfaced in `unknownDepIds`, not summed.
 */
export function computeRequiredSpace(opts: {
  db: SqliteDb | null
  mods: SyncMod[] // sizing catalog (usually the FULL backup list, so pulled-in deps can be sized)
  targetIds?: number[] // ids to plan/install; default = every id in `mods`
  stockGameDir: string
  exists: (p: string) => boolean
  profile?: TextureProfile
  // For a target being installed, the modId of its Phase-B ITA translation (or null). Its archive is
  // a SECOND download applied over the base, so its size must be reserved too (else it goes uncounted).
  translationIdOf?: (baseModId: number) => number | null
}): RequiredSpace {
  const profile = opts.profile ?? DEFAULT_TEXTURE_PROFILE
  const modsDir = stockGameModsDir(opts.stockGameDir)

  // Profile-aware size maps (active profile + 4K baseline) keyed by modId. Only TRUSTED (finite,
  // positive) sizes get an entry — a missing/0/negative size leaves the id ABSENT so it is later
  // treated as "unknown", never as a free 0-byte mod (the under-reservation fail-open).
  const resolvedActive = resolveMods(opts.mods, profile)
  const sizeActive = new Map<number, number>()
  const size4K = new Map<number, number>()
  for (const m of resolvedActive) {
    const s = trustedSize(m.fileSize)
    if (s > 0) sizeActive.set(m.modId, s)
  }
  for (const m of resolveMods(opts.mods, '4K')) {
    const s = trustedSize(m.fileSize)
    if (s > 0) size4K.set(m.modId, s)
  }

  // A mod is "installed" when its stable extraction dir exists. The dir name derives from the
  // PROFILE-SELECTED file name (processOne + the internal preflight both use resolveMods), so detect
  // installs over the RESOLVED mods too — checking the raw base name would miss a 2K-installed mod.
  const installedIds = new Set<number>()
  for (const m of resolvedActive) if (opts.exists(modDestDir(modsDir, m))) installedIds.add(m.modId)

  const allIds = opts.mods.map((m) => m.modId)
  const targetIds = (opts.targetIds ?? allIds).filter((id) => Number.isInteger(id))
  const targetSet = new Set(targetIds)

  // Expand the selection with its transitive dependencies (fail-soft: no catalog ⇒ plain selection).
  const installedArr = [...installedIds]
  let plannedIds: number[]
  let usedDependencyGraph = false
  if (opts.db) {
    const res = resolveInstallPlan(opts.db, targetIds, installedArr)
    if (res.success && res.plan && res.plan.length) {
      plannedIds = res.plan.map((p) => p.nexus_id)
      usedDependencyGraph = true
    } else {
      plannedIds = targetIds.filter((id) => !installedIds.has(id))
    }
  } else {
    plannedIds = targetIds.filter((id) => !installedIds.has(id))
  }

  const extraDepIds: number[] = []
  const unsizedTargetIds: number[] = []
  const unknownDepIds: number[] = []
  const unsizedTranslationIds: number[] = []
  let requiredBytes = 0
  let requiredBytes4K = 0
  let translationBytes = 0
  for (const id of plannedIds) {
    if (installedIds.has(id)) continue // defensive: never count something already on disk
    const isTarget = targetSet.has(id)
    if (!isTarget) extraDepIds.push(id)
    if (!sizeActive.has(id)) {
      // Unknown size. If it's a TARGET this run downloads, that is real doubt → flag it so the gate
      // blocks. If it's a catalog-only dependency (not downloaded here), it's merely informational.
      if (isTarget) unsizedTargetIds.push(id)
      else unknownDepIds.push(id)
      continue
    }
    const active = sizeActive.get(id) ?? 0
    requiredBytes += active
    requiredBytes4K += size4K.get(id) ?? active
    // Phase-B ITA translation archive: a second download over this base — reserve its bytes too.
    if (isTarget && opts.translationIdOf) {
      const tId = opts.translationIdOf(id)
      if (tId != null && sizeActive.has(tId)) {
        const tActive = sizeActive.get(tId) ?? 0
        requiredBytes += tActive
        requiredBytes4K += size4K.get(tId) ?? tActive
        translationBytes += tActive
      } else if (tId != null) {
        unsizedTranslationIds.push(tId) // this run WILL download it; size unknown — surfaced, not blocking
      }
    }
  }

  return {
    targetIds,
    plannedIds,
    extraDepIds,
    unsizedTargetIds,
    unknownDepIds,
    unsizedTranslationIds,
    usedDependencyGraph,
    requiredBytes,
    requiredBytes4K,
    savingBytes: Math.max(0, requiredBytes4K - requiredBytes),
    translationBytes,
    profile,
  }
}

export interface DiskGate {
  requiredBytes: number
  bufferFactor: number
  requiredWithBuffer: number // requiredBytes × bufferFactor (the space that must actually be free)
  freeBytes: number
  ok: boolean // freeBytes ≥ requiredWithBuffer
  missingBytes: number // 0 when ok, else how many bytes short of requiredWithBuffer
}

/**
 * Fail-closed gate: the queue may start ONLY if free space clears required × (1 + buffer). Any
 * doubt (negative/NaN free, zero required with the buffer still unmet) resolves to a block, never a
 * pass. `missingBytes` is what the UI reports as "you need N more GB".
 */
export function computeDiskGate(
  requiredBytes: number,
  freeBytes: number,
  bufferFactor: number = DISK_BUFFER_FACTOR,
): DiskGate {
  const req = Number.isFinite(requiredBytes) ? Math.max(0, requiredBytes) : Infinity
  const free = Number.isFinite(freeBytes) ? freeBytes : -Infinity // unreadable free space ⇒ block
  const requiredWithBuffer = Math.ceil(req * bufferFactor)
  const ok = free >= requiredWithBuffer
  return {
    requiredBytes: req,
    bufferFactor,
    requiredWithBuffer,
    freeBytes,
    ok,
    missingBytes: ok ? 0 : Math.max(0, requiredWithBuffer - free),
  }
}

export type DiskBlockReason = 'ok' | 'insufficient' | 'unsized' | 'unreadable'

export interface DiskDecision {
  ok: boolean
  reason: DiskBlockReason
  requiredBytes: number // binding requirement: the STRICTER of the ×1.15 gate and the peak+floor model
  freeBytes: number
  missingBytes: number // how many more bytes must be free (0 when ok or when the blocker isn't space)
  unsizedTargets: number[] // targets we couldn't size ⇒ 'unsized' block
  // Cross-disk only: the downloads-cache volume (null = same volume as the StockGame, no second
  // probe). The cache RETAINS every archive of the run, so on a separate volume it needs the full
  // archive footprint + the 15 GB floor — otherwise the gate passes on the StockGame disk and the
  // cache disk fills mid-run anyway.
  downloadsFreeBytes: number | null
  downloadsRequiredBytes: number // 0 when same-volume; archives + 15 GB floor when cross-disk
  gate: DiskGate
  preflight: DiskPreflight
}

/**
 * The single, pure GO/NO-GO decision the orchestrator makes before starting the queue. It composes
 * BOTH models over the same required footprint and fails closed on every kind of doubt:
 *   • 'unreadable' — free space couldn't be probed (non-finite) ⇒ BLOCK (never assume infinite room).
 *   • 'unsized'    — a mod this run will download has no trustworthy size ⇒ BLOCK (can't certify).
 *   • 'insufficient' — free space can't clear required × 1.15 OR the extraction peak + 15 GB residual.
 * `requiredBytes` is the STRICTER of the two models so the reported "need N GB / missing N GB" is
 * always internally consistent (required ≥ free + missing), never the understated gate-only figure.
 */
export function decideDiskGate(opts: {
  required: RequiredSpace
  freeBytes: number
  sameDisk?: boolean
  extractionOverhead?: number
  safetyFactor?: number
  // Free space on the downloads-cache volume when it DIFFERS from the StockGame volume (cross-disk
  // runs). Omit/null when they share a volume — freeBytes already covers the cache footprint there.
  downloadsFreeBytes?: number | null
}): DiskDecision {
  const { required, freeBytes } = opts
  const gate = computeDiskGate(required.requiredBytes, freeBytes)
  const preflight = computeDiskPreflight({
    pendingBytes: required.requiredBytes,
    freeBytes,
    sameDisk: opts.sameDisk,
    extractionOverhead: opts.extractionOverhead,
    safetyFactor: opts.safetyFactor,
  })
  // Binding requirement: max of the simple buffered gate and the rich model's peak + 15 GB residual,
  // so free must clear whichever is larger. Keeps the user-facing required/missing figures coherent.
  const requiredBytes = Math.max(gate.requiredWithBuffer, preflight.requiredBytes + preflight.minFreeMarginBytes)
  const finiteFree = Number.isFinite(freeBytes) ? freeBytes : 0
  const missingBytes = Math.max(0, requiredBytes - finiteFree)

  let reason: DiskBlockReason
  if (!Number.isFinite(freeBytes)) reason = 'unreadable'
  else if (required.unsizedTargetIds.length > 0) reason = 'unsized'
  else if (!gate.ok || !preflight.ok) reason = 'insufficient'
  else reason = 'ok'
  let missing = reason === 'ok' ? 0 : missingBytes

  // Second volume (cross-disk): the archive cache must also fit, with the same 15 GB floor. Checked
  // only if the StockGame volume passed — a stock-volume block is the bigger, primary story.
  const downloadsFree = opts.downloadsFreeBytes ?? null
  const downloadsRequiredBytes =
    downloadsFree == null ? 0 : Math.ceil(required.requiredBytes + MIN_FREE_MARGIN_BYTES)
  if (downloadsFree != null && reason === 'ok') {
    if (!Number.isFinite(downloadsFree)) reason = 'unreadable'
    else if (downloadsFree < downloadsRequiredBytes) {
      reason = 'insufficient'
      missing = downloadsRequiredBytes - downloadsFree
    }
  }

  return {
    ok: reason === 'ok',
    reason,
    requiredBytes,
    freeBytes,
    missingBytes: reason === 'ok' ? 0 : missing,
    unsizedTargets: required.unsizedTargetIds,
    downloadsFreeBytes: downloadsFree,
    downloadsRequiredBytes,
    gate,
    preflight,
  }
}
