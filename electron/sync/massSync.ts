import { join } from 'path'
import { isPathInside } from './../install/extract'
import { sameVolume } from './../install/stockGame'
import { CircuitBreaker, withRetry } from './../install/retryPolicy'
import { sanitizePathSegment } from './../util/paths'
import {
  resolveMods,
  DEFAULT_TEXTURE_PROFILE,
  type TextureProfile,
  type TextureVariant,
} from './textureProfile'

// ─────────────────────────────────────────────────────────────────────────────
// Mass-sync orchestrator (hardened) — production version of scripts/e2e_batch.mjs.
//
// Drives a whole modlist (the 4.568 mods from vortex-collections-backup.json) through
// the tested primitives: resolve download_link (Premium) → RESUMABLE download
// (.part + Range) → md5 vs backup (fail-closed) → extract. Hardening over the first cut:
//   • RETRY: shared retryPolicy (classify 429/5xx/ECONNRESET/TLS/CF transient) + jittered
//     backoff + a shared circuit breaker that halts the run on a systemic failure run.
//   • TELEMETRY: byte-precise progress (real bytes from streamDownload, not fileSize jumps),
//     live throughput (MB/s) and ETA (s).
//   • DETAIL: each active item carries {phase, downloaded, total, percent}; the overall bar
//     is byte-monotonic so the UI never shows a confusing 100→0→100.
//   • ABORT: extract receives the AbortSignal (kills the 7-Zip child); a failed mod's partial
//     extraction is removed so a resumed run never mistakes it for "done" (the .part survives
//     in the downloads cache for a resumed download).
// All IO is injected → fully unit-testable with no network/disk.
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncMod {
  modId: number
  fileId: number
  name: string
  md5?: string
  fileSize?: number
  // Resolution alternatives (2K/4K/…) reconstructed from the raw backup. When present, the active
  // textureProfile selects which one is actually downloaded (see ./textureProfile).
  variants?: TextureVariant[]
}

export type SyncItemPhase = 'downloading' | 'verifying' | 'extracting'
export interface ActiveItem {
  name: string
  phase: SyncItemPhase
  downloaded: number
  total: number
  percent: number
}

export interface SyncProgress {
  phase: 'preparing' | 'syncing' | 'done' | 'cancelled' | 'error'
  modsTotal: number
  modsDone: number
  modsFailed: number
  modsSkipped: number
  bytesDownloaded: number // BYTE-PRECISE: completed mods' real bytes + active live bytes
  bytesTotal: number
  throughputMBps: number // smoothed download throughput
  etaSeconds: number | null // null until throughput is known
  active: ActiveItem[]
  lastMessage?: string
}

export interface MassSyncDeps {
  resolveLink(modId: number, fileId: number): Promise<string>
  streamDownload(
    url: string,
    destPath: string,
    onProgress: (downloaded: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<{ bytes: number }>
  md5(path: string): Promise<string>
  extract(
    archive: string,
    destDir: string,
    onProgress: (p: number) => void,
    signal: AbortSignal,
  ): Promise<{ method: string }>
  // Extract an archive INTO an existing dir, OVERWRITING matching files but keeping the rest
  // (merge/overlay). Used for Phase B: an ITA translation dropped on top of the base mod.
  extractOverlay?(
    archive: string,
    destDir: string,
    onProgress: (p: number) => void,
    signal: AbortSignal,
  ): Promise<{ method: string }>
  exists(p: string): boolean
  ensureDir(p: string): void
  remove(p: string): void // file OR dir (rmSync recursive/force) — archive cleanup + partial-extract cleanup
  freeSpace(path: string): Promise<number> // bytes free on the volume containing `path`
  // Total real bytes under an extracted mod dir (statSync-summed). 0 ⇒ empty/corrupt
  // partial folder that resume must DISCARD and re-extract rather than skip. Optional:
  // when absent, resume falls back to presence-only (an existing dir counts as done).
  dirBytes?(p: string): number
}

export interface MassSyncConfig {
  mods: SyncMod[]
  stockGameDir: string
  steamGamePath: string | null
  downloadsDir: string
  concurrency: number
  signal: AbortSignal
  maxRetries?: number // per-mod network retries (default 3)
  errorThreshold?: number // consecutive mod failures that trip the breaker (default 50)
  baseMs?: number // backoff base (default 500; 0 for instant retries in tests)
  capMs?: number // backoff cap (default 8000)
  extractionOverhead?: number // extracted-vs-archive size factor (default 1.5)
  safetyFactor?: number // cross-disk headroom on the estimate (default 1.15; same-disk uses SAME_DISK_EXTRACT_FACTOR)
  skipDiskCheck?: boolean // bypass the aggregate disk pre-flight (tests / explicit override)
  textureProfile?: TextureProfile // 2K/4K quality profile; selects per-mod variant (default 4K)
  // Best-effort ITA translation: when enabled and translationOf returns a mapping, a second phase
  // extracts the translation OVER the base mod in the same worker slot (see processOne Phase B).
  enableAutoTranslate?: boolean // default true
  translationOf?: (modId: number) => { nexus_id: number; file_id: number | null; md5: string | null } | null
  onProgress?: (s: SyncProgress) => void
  onLog?: (m: string) => void
  now?: () => number // injectable clock (default Date.now) for throughput/ETA + tests
  random?: () => number // injectable jitter source for deterministic tests
}

export function stockGameModsDir(stockGameDir: string): string {
  return join(stockGameDir, 'mods')
}
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Hard guard: the StockGame must NOT be, contain, or live inside the real Steam install. */
export function assertIsolated(stockGameDir: string, steamGamePath: string | null): void {
  if (!stockGameDir) throw new Error('Cartella StockGame non configurata')
  if (!steamGamePath) return
  const sg = norm(stockGameDir),
    st = norm(steamGamePath)
  if (sg === st || isPathInside(st, sg) || isPathInside(sg, st)) {
    throw new Error(
      `Isolamento violato: lo StockGame ("${stockGameDir}") coincide o si sovrappone all'install Steam ("${steamGamePath}"). Usa una cartella separata, fuori dalla cartella del gioco.`,
    )
  }
}

export function sanitize(name: string): string {
  return sanitizePathSegment(name)
}
export function filenameFromUrl(url: string, fallback: string): string {
  try {
    const n = decodeURIComponent(new URL(url).pathname).split('/').pop()
    return n || fallback
  } catch {
    return fallback
  }
}

/** Stable per-mod extraction dir (independent of the archive filename → known before download). */
export function modDestDir(modsDir: string, m: SyncMod): string {
  return join(modsDir, `${m.modId}-${sanitize(m.name)}`)
}

// ── Aggregate disk pre-flight (PRECHECK-01) ──────────────────────────────────

/** Extracted output is estimated as pendingBytes × extractionOverhead. */
// 1.5, not 1.10: texture-heavy BSA/BC7 archives expand far past their compressed size,
// so an optimistic factor let the real peak overrun free space mid-install ("Disco pieno").
export const DEFAULT_EXTRACTION_OVERHEAD = 1.5
export const DEFAULT_SAFETY_FACTOR = 1.15 // cross-disk headroom on the extracted estimate
export const SAME_DISK_EXTRACT_FACTOR = 1.5 // same-disk: heavier headroom (archives + extract contend)
export const MIN_FREE_MARGIN_BYTES = 15 * 1024 ** 3 // hard NO-GO floor: keep ≥15 GB free after the run

export interface DiskPreflight {
  pendingBytes: number // raw sum of fileSize for mods NOT yet present
  extractionOverhead: number // extracted-vs-archive multiplier applied
  safetyFactor: number // headroom multiplier applied
  sameDisk: boolean // downloads cache and StockGame share one volume
  requiredBytes: number // pending(cache) + extracted × (sameDisk ? 1.5 : safetyFactor)
  freeBytes: number // free space on the StockGame volume
  minFreeMarginBytes: number // required residual free space AFTER the run (15 GB floor)
  marginBytes: number // freeBytes − requiredBytes (the projected residual)
  ok: boolean // marginBytes ≥ minFreeMarginBytes
}

/** Sum fileSize of mods STILL TO sync (their extract dir does not yet exist). */
export function pendingBytes(mods: SyncMod[], modsDir: string, exists: (p: string) => boolean): number {
  return mods.reduce((acc, m) => acc + (exists(modDestDir(modsDir, m)) ? 0 : (m.fileSize ?? 0)), 0)
}

/**
 * Pure disk pre-flight (honest / bulletproof): required = pending(cache) + extracted × headroom.
 *   • extracted = pending × extractionOverhead (default 1.5 — texture archives expand well
 *     past their compressed size; 1.10 was a lower bound that under-counted the real peak).
 *   • the download cache is ALWAYS counted: archives are retained (never deleted post-extract),
 *     so the pending-archive bytes are added on BOTH paths, not only same-disk. Erring toward
 *     over-estimation blocks up front instead of failing "Disco pieno" mid-install.
 *   • headroom = SAME_DISK_EXTRACT_FACTOR (1.5) when downloads + StockGame share a volume and
 *     contend, else safetyFactor (1.15). Both configurable.
 */
export function computeDiskPreflight(p: {
  pendingBytes: number
  freeBytes: number
  extractionOverhead?: number
  safetyFactor?: number
  sameDisk?: boolean
}): DiskPreflight {
  const extractionOverhead = p.extractionOverhead ?? DEFAULT_EXTRACTION_OVERHEAD
  const safetyFactor = p.safetyFactor ?? DEFAULT_SAFETY_FACTOR
  const sameDisk = p.sameDisk ?? false
  const pending = Math.max(0, p.pendingBytes)
  const extractedBytes = pending * extractionOverhead
  // Peak on the StockGame volume = retained archive cache (pending) + extracted output × headroom.
  // The cache term is unconditional: archives survive extraction, so they occupy space during the
  // whole run. Same-disk uses the heavier 1.5 headroom (archives + extract compete for one volume).
  const headroom = sameDisk ? SAME_DISK_EXTRACT_FACTOR : safetyFactor
  const requiredBytes = Math.ceil(pending + extractedBytes * headroom)
  const marginBytes = p.freeBytes - requiredBytes
  return {
    pendingBytes: p.pendingBytes,
    extractionOverhead,
    safetyFactor,
    sameDisk,
    requiredBytes,
    freeBytes: p.freeBytes,
    minFreeMarginBytes: MIN_FREE_MARGIN_BYTES,
    marginBytes,
    // NO-GO unless the projected residual free space stays at/above the 15 GB floor.
    ok: marginBytes >= MIN_FREE_MARGIN_BYTES,
  }
}

/** IO wrapper: compute the pre-flight for a run (sums pending, reads free space). */
export async function diskPreflight(
  deps: Pick<MassSyncDeps, 'exists' | 'freeSpace'>,
  cfg: {
    mods: SyncMod[]
    stockGameDir: string
    downloadsDir?: string
    extractionOverhead?: number
    safetyFactor?: number
    textureProfile?: TextureProfile
  },
): Promise<DiskPreflight> {
  const modsDir = stockGameModsDir(cfg.stockGameDir)
  // Estimate against the PROFILE-SELECTED files, so a 2K profile estimates the lighter archives.
  const resolved = resolveMods(cfg.mods, cfg.textureProfile ?? DEFAULT_TEXTURE_PROFILE)
  const pend = pendingBytes(resolved, modsDir, deps.exists)
  const free = await deps.freeSpace(cfg.stockGameDir)
  // Same-disk ⇒ archives + extracted output compete for one volume (heavier estimate).
  const sameDisk = cfg.downloadsDir ? sameVolume(cfg.downloadsDir, cfg.stockGameDir) : false
  return computeDiskPreflight({
    pendingBytes: pend,
    freeBytes: free,
    extractionOverhead: cfg.extractionOverhead,
    safetyFactor: cfg.safetyFactor,
    sameDisk,
  })
}

export async function runMassSync(deps: MassSyncDeps, cfg: MassSyncConfig): Promise<SyncProgress> {
  assertIsolated(cfg.stockGameDir, cfg.steamGamePath)
  const modsDir = stockGameModsDir(cfg.stockGameDir)
  deps.ensureDir(cfg.downloadsDir)
  deps.ensureDir(modsDir)

  // Resolve every mod to the file matching the active texture profile (2K/4K) ONCE, up front:
  // the preflight estimate, the total bytes and the download loop all consume the same selection,
  // so switching profile changes both the estimated weight and the URLs/fileIds coherently.
  const profile = cfg.textureProfile ?? DEFAULT_TEXTURE_PROFILE
  const mods = resolveMods(cfg.mods, profile)

  // Aggregate disk pre-flight (PRECHECK-01) — BLOCK before any download if the StockGame
  // volume can't hold the estimated extracted output. Fail-closed.
  if (!cfg.skipDiskCheck) {
    const pf = await diskPreflight(deps, {
      mods: cfg.mods,
      stockGameDir: cfg.stockGameDir,
      downloadsDir: cfg.downloadsDir,
      extractionOverhead: cfg.extractionOverhead,
      safetyFactor: cfg.safetyFactor,
      textureProfile: profile,
    })
    const gb = (b: number) => (b / 1024 ** 3).toFixed(1)
    if (!pf.ok) {
      const headroom = pf.sameDisk ? SAME_DISK_EXTRACT_FACTOR : pf.safetyFactor
      const formula = `cache archivi ${gb(pf.pendingBytes)} + estratto (×${pf.extractionOverhead}) ×${headroom} margine${pf.sameDisk ? ' stesso disco' : ''}`
      const msg = `Spazio su disco insufficiente per lo StockGame: richiesti ~${gb(pf.requiredBytes)} GB (${formula}), liberi ${gb(pf.freeBytes)} GB → residuo previsto ${gb(pf.marginBytes)} GB, sotto il minimo di ${gb(pf.minFreeMarginBytes)} GB. Libera spazio o sposta lo StockGame su un volume più capiente.`
      cfg.onLog?.(msg)
      throw new Error(msg)
    }
    cfg.onLog?.(
      `Pre-flight disco OK${pf.sameDisk ? ' (stesso disco)' : ''}: richiesti ~${gb(pf.requiredBytes)} GB · liberi ${gb(pf.freeBytes)} GB · residuo ${gb(pf.marginBytes)} GB (min ${gb(pf.minFreeMarginBytes)} GB)`,
    )
  }

  const now = cfg.now ?? Date.now
  const maxRetries = cfg.maxRetries ?? 3
  const breaker = new CircuitBreaker(cfg.errorThreshold ?? 50)
  let halted = false

  const total = mods.length
  const slots = new Set<ActiveItem>()
  let completedBytes = 0 // real bytes of finished mods (+ skipped mods' nominal size)
  const state: SyncProgress = {
    phase: 'syncing',
    modsTotal: total,
    modsDone: 0,
    modsFailed: 0,
    modsSkipped: 0,
    bytesDownloaded: 0,
    bytesTotal: mods.reduce((a, m) => a + (m.fileSize ?? 0), 0),
    throughputMBps: 0,
    etaSeconds: null,
    active: [],
  }

  // throughput sampler (EMA over ≥400 ms windows)
  let lastT = now(),
    lastB = 0,
    emaBps = 0
  const sample = () => {
    const t = now(),
      dt = (t - lastT) / 1000
    if (dt >= 0.4) {
      const inst = Math.max(0, (state.bytesDownloaded - lastB) / dt)
      emaBps = emaBps === 0 ? inst : 0.4 * inst + 0.6 * emaBps
      lastT = t
      lastB = state.bytesDownloaded
    }
  }

  let lastEmit = 0
  const emit = (force = false, msg?: string) => {
    if (msg) state.lastMessage = msg
    // byte-precise: completed + the live bytes of every in-flight download
    let live = completedBytes
    for (const s of slots) live += s.downloaded
    state.bytesDownloaded = Math.min(state.bytesTotal || live, live)
    sample()
    state.throughputMBps = emaBps / (1024 * 1024)
    const remaining = Math.max(0, state.bytesTotal - state.bytesDownloaded)
    state.etaSeconds = emaBps > 0 && state.bytesTotal > 0 ? Math.round(remaining / emaBps) : null
    const t = now()
    if (!force && t - lastEmit < 120) return // throttle progress ticks; state changes pass force=true
    lastEmit = t
    state.active = [...slots].map((s) => ({ ...s }))
    cfg.onProgress?.({ ...state, active: state.active })
  }
  emit(true)

  const processOne = async (m: SyncMod, slot: ActiveItem): Promise<'done' | 'skipped'> => {
    const destDir = modDestDir(modsDir, m)
    if (!isPathInside(cfg.stockGameDir, destDir))
      throw new Error('target di estrazione fuori dallo StockGame')
    // Resume: an existing dest dir counts as "done" ONLY if it actually holds bytes.
    // A prior crash could leave an empty/corrupt partial dir — check real bytes with
    // dirBytes (statSync-summed) and DISCARD it so it gets re-extracted, not skipped.
    if (deps.exists(destDir)) {
      const bytes = deps.dirBytes ? deps.dirBytes(destDir) : 1
      if (bytes > 0) return 'skipped'
      deps.remove(destDir) // empty/corrupt partial → wipe and fall through to re-download+extract
    }

    // 1) download with retry (resume-aware: streamDownload resumes from .part via Range).
    let archive = ''
    await withRetry(
      async () => {
        slot.phase = 'downloading'
        const url = await deps.resolveLink(m.modId, m.fileId)
        archive = join(cfg.downloadsDir, sanitize(filenameFromUrl(url, `mod_${m.modId}_${m.fileId}.7z`)))
        await deps.streamDownload(
          url,
          archive,
          (d, t) => {
            slot.downloaded = d
            slot.total = t || slot.total
            slot.percent = t > 0 ? Math.round((d / t) * 100) : 0
            emit()
          },
          cfg.signal,
        )
      },
      {
        maxRetries,
        signal: cfg.signal,
        baseMs: cfg.baseMs ?? 500,
        capMs: cfg.capMs ?? 8000,
        random: cfg.random,
        onRetry: (a, delay, err) =>
          cfg.onLog?.(
            `↻ retry ${a}/${maxRetries} ${m.name} fra ${delay}ms: ${(err as Error)?.message ?? err}`,
          ),
      },
    )
    if (cfg.signal.aborted) throw new Error('annullato')

    // 2) md5 vs backup — fail-closed
    if (m.md5) {
      slot.phase = 'verifying'
      emit(true)
      const got = await deps.md5(archive)
      if (got.toLowerCase() !== m.md5.toLowerCase()) {
        deps.remove(archive)
        throw new Error(`md5 non combacia (atteso ${m.md5.slice(0, 12)}…, ottenuto ${got.slice(0, 12)}…)`)
      }
    }

    // 3) extract ONLY into StockGame/mods (abortable; partial extraction cleaned on failure by the worker)
    slot.phase = 'extracting'
    slot.percent = 0
    emit(true)
    await deps.extract(
      archive,
      destDir,
      (p) => {
        slot.percent = p
        emit()
      },
      cfg.signal,
    )

    // ── Phase B: best-effort ITA translation override (SAME slot, sequential) ───────────────────
    // If auto-translate is on and a mapping exists, download the ITA patch and extract it OVER the
    // base mod (overwrite matching files, keep the rest). FAIL-SOFT: any error here leaves the base
    // install intact and the mod still counts as 'done' — it NEVER aborts the run, except on a real
    // user cancel (cfg.signal.aborted), which must propagate. Same worker slot ⇒ no extra
    // concurrency, no race between base and its translation.
    if (cfg.enableAutoTranslate !== false && cfg.translationOf && deps.extractOverlay) {
      const tr = cfg.translationOf(m.modId)
      if (tr && tr.file_id) {
        try {
          slot.phase = 'downloading'
          slot.downloaded = 0
          slot.percent = 0
          emit(true)
          const turl = await deps.resolveLink(tr.nexus_id, tr.file_id)
          const tArchive = join(
            cfg.downloadsDir,
            sanitize(filenameFromUrl(turl, `trans_${tr.nexus_id}_${tr.file_id}.7z`)),
          )
          await deps.streamDownload(
            turl,
            tArchive,
            (d, t) => {
              slot.downloaded = d
              slot.total = t || slot.total
              slot.percent = t > 0 ? Math.round((d / t) * 100) : 0
              emit()
            },
            cfg.signal,
          )
          if (cfg.signal.aborted) throw new Error('annullato')
          if (tr.md5) {
            slot.phase = 'verifying'
            emit(true)
            const got = await deps.md5(tArchive)
            if (got.toLowerCase() !== tr.md5.toLowerCase())
              throw new Error(`md5 traduzione non combacia (atteso ${tr.md5.slice(0, 12)}…)`)
          }
          slot.phase = 'extracting'
          slot.percent = 0
          emit(true)
          await deps.extractOverlay(
            tArchive,
            destDir,
            (p) => {
              slot.percent = p
              emit()
            },
            cfg.signal,
          )
          cfg.onLog?.(`✔ traduzione ITA applicata: ${m.name}`)
        } catch (e) {
          if (cfg.signal.aborted) throw e // a genuine user cancel must still stop the run
          // FAIL-SOFT: base stays installed (English); the mod is still 'done'.
          cfg.onLog?.(`⚠ traduzione ITA non applicata a ${m.name} (fail-soft): ${(e as Error).message}`)
        }
      }
    }
    return 'done'
  }

  let idx = 0
  const worker = async (): Promise<void> => {
    while (!cfg.signal.aborted && !halted) {
      const i = idx++
      if (i >= total) return
      const m = mods[i]
      const slot: ActiveItem = {
        name: m.name,
        phase: 'downloading',
        downloaded: 0,
        total: m.fileSize ?? 0,
        percent: 0,
      }
      slots.add(slot)
      emit(true)
      try {
        const r = await processOne(m, slot)
        if (r === 'skipped') {
          state.modsSkipped++
          completedBytes += m.fileSize ?? 0
        } else {
          state.modsDone++
          completedBytes += slot.downloaded || (m.fileSize ?? 0)
        }
        breaker.recordSuccess()
        slots.delete(slot)
        emit(true, `✓ ${m.name}`)
      } catch (e) {
        slots.delete(slot)
        if (cfg.signal.aborted) {
          emit(true)
          return
        } // cancellation: not a failure
        // partial extraction (if any) must not look "done" on a resumed run; .part stays for resume
        try {
          deps.remove(modDestDir(modsDir, m))
        } catch {
          /* best effort */
        }
        state.modsFailed++
        breaker.recordFailure()
        const msg = (e as Error).message
        cfg.onLog?.(`✗ ${m.name}: ${msg}`)
        if (breaker.isOpen()) {
          halted = true
          cfg.onLog?.(`⛔ circuit breaker: ${breaker.failures} fallimenti consecutivi — sync sospesa`)
          emit(true, `Sospeso: troppi errori consecutivi (${breaker.failures})`)
        } else emit(true, `✗ ${m.name}: ${msg}`)
      }
    }
  }

  const n = Math.max(1, Math.min(cfg.concurrency || 1, Math.max(1, total)))
  await Promise.all(Array.from({ length: n }, () => worker()))

  state.phase = cfg.signal.aborted ? 'cancelled' : state.modsFailed > 0 || halted ? 'error' : 'done'
  emit(true)
  return state
}
