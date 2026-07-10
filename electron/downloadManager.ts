import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join, extname } from 'path'
import Database from 'better-sqlite3'
import type Store from 'electron-store'
import { logger } from './logger'
import { streamToFile } from './install/downloadStream'
import { resolveDownloadLink } from './nexus/downloadLink'
import { classifyDownloadFailure, backoffWithJitter, CircuitBreaker } from './install/retryPolicy'
import { sanitizePathSegment } from './util/paths'
import { axiosGet, axiosJson } from './http/axiosAdapters'

interface DownloadRow {
  id: number
  mod_id: number | null
  nexus_id: number | null
  file_id: number | null
  name: string
  url: string | null
  file_path: string | null
  total_size: number
  downloaded_size: number
  status: string
  nxm_key: string | null
  nxm_expires: number | null
}

interface DownloadTask {
  id: number
  abortController: AbortController
}

interface DownloadManagerOptions {
  store: Store
  getApiKey: () => string | undefined
  /** Called after a download finishes successfully, to kick off extraction/install. */
  onInstall?: (downloadId: number) => void
}

const activeDownloads = new Map<number, DownloadTask>()
const queue: number[] = []

const sanitizeFilename = (name: string): string => sanitizePathSegment(name, 'download')

// Stable per-download base name. The Nexus file_id (when known) is part of the
// name: two different files of the SAME mod (main + update, or two versions) no
// longer collide on one archive path / one .part.
function archiveBaseName(row: Pick<DownloadRow, 'name' | 'file_id'>): string {
  const base = sanitizeFilename(row.name)
  return row.file_id ? `${base}-f${row.file_id}` : base
}

function guessExtension(url: string): string {
  const ext = extname(url.split('?')[0]).toLowerCase()
  return ['.7z', '.zip', '.rar', '.exe'].includes(ext) ? ext : '.7z' // Nexus archives default to .7z
}

// Direct-download guard. A pre-stored `url` (from a signed delta manifest, or from the
// renderer via downloads:add) is fetched by the MAIN process, so it must be constrained:
//   • https only — a plaintext http:// download is MITM-able and would defeat the whole
//     signed-archive story,
//   • no internal/loopback/link-local host — otherwise a renderer-supplied URL turns the
//     main process into an SSRF proxy that can reach localhost / the LAN.
// Nexus-resolved links (mod_id+file_id) don't pass through here; they're already trusted.
export function assertSafeDirectUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('URL di download non valido')
  }
  if (u.protocol !== 'https:') throw new Error('Download diretto non-HTTPS rifiutato')
  const host = u.hostname.toLowerCase()
  const internal =
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  if (internal) throw new Error(`host di download non consentito (interno): ${host}`)
  return u.toString()
}

export function initDownloadManager(
  db: Database.Database,
  win: () => BrowserWindow | null,
  opts: DownloadManagerOptions,
) {
  const { store, getApiKey, onInstall } = opts
  const downloadsDir = join(app.getPath('userData'), 'downloads')
  if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true })

  // Resilience config mirroring Nolvus's [Process] section (Retry / ErrorsThreshold):
  // each download is retried with backoff, and a run of failures halts the queue
  // so a systemic problem (offline, bad API key) doesn't burn through everything.
  const attempts = new Map<number, number>()
  let queueHalted = false

  const maxConcurrent = () => Math.max(1, Math.min(8, Number(store.get('downloadThreads')) || 4))
  const maxRetries = () => Math.max(0, Math.min(10, Number(store.get('downloadRetries') ?? 3)))
  const errorThreshold = () => Math.max(1, Number(store.get('errorThreshold')) || 50)
  // Shared retry/circuit-breaker policy (same module the mass-sync orchestrator uses).
  const breaker = new CircuitBreaker(errorThreshold())

  const getRow = (id: number) =>
    db.prepare('SELECT * FROM downloads WHERE id=?').get(id) as DownloadRow | undefined

  // Catalog rows store the mod PAGE url. A real file download needs either a direct
  // CDN link or a Nexus-generated (Premium) link built from nexus_id + file_id.
  async function resolveUrl(row: DownloadRow, signal?: AbortSignal): Promise<string> {
    // A direct CDN/file URL (not a mod PAGE) is used as-is.
    const isModPage = !!row.url && /nexusmods\.com\/.*\/mods\/\d+\/?$/i.test(row.url)
    if (row.url && !isModPage && /^https?:\/\//i.test(row.url)) return assertSafeDirectUrl(row.url)

    // Otherwise resolve through the Nexus download_link endpoint (auth headers +
    // error mapping live in the resolver). The nxm key/expires (non-premium) are
    // forwarded as query params; premium accounts resolve from mod/file id alone.
    if (row.nexus_id && row.file_id) {
      // An expired nxm key would bounce with a misleading "richiede Premium":
      // fail with the actionable message instead (re-click the link on Nexus).
      if (row.nxm_key && row.nxm_expires && row.nxm_expires * 1000 < Date.now()) {
        throw new Error('Link nxm scaduto: torna sulla pagina Nexus e clicca di nuovo "Mod Manager Download"')
      }
      return resolveDownloadLink(axiosJson, {
        modId: row.nexus_id,
        fileId: row.file_id,
        apiKey: getApiKey(),
        key: row.nxm_key ?? undefined,
        expires: row.nxm_expires ?? undefined,
        signal, // forward the abort signal so a pause tears down an in-flight resolve promptly
      })
    }
    throw new Error('Link di download non disponibile: serve un URL diretto oppure mod/file id Nexus.')
  }

  // Download cache (mirrors Nolvus's Cache/ folder): if an archive for this mod
  // is already on disk from a previous download, reuse it instead of re-fetching
  // (mod archives are often hundreds of MB to multiple GB). A hit must MATCH the
  // expected size when we know it — a truncated/corrupt leftover from a previous
  // run must never flow straight into the extractor.
  function findCachedArchive(row: DownloadRow): string | null {
    const base = archiveBaseName(row)
    for (const ext of ['.7z', '.zip', '.rar', '.exe']) {
      const candidate = join(downloadsDir, `${base}${ext}`)
      try {
        if (!existsSync(candidate)) continue
        const size = statSync(candidate).size
        if (size <= 0) continue
        if (row.total_size > 0 && size !== row.total_size) {
          logger.warn(
            'download',
            `cache ignorata per "${row.name}": dimensione ${size} ≠ attesa ${row.total_size}`,
          )
          continue
        }
        return candidate
      } catch {
        /* ignore */
      }
    }
    return null
  }

  async function startDownload(downloadId: number): Promise<void> {
    if (activeDownloads.has(downloadId)) return
    const row = getRow(downloadId)
    if (!row) return

    // Cache hit → skip the network entirely and hand straight to the installer.
    const cached = findCachedArchive(row)
    if (cached) {
      logger.info('download', `Cache hit per "${row.name}" → ${cached}`)
      db.prepare(
        "UPDATE downloads SET status='completed', file_path=?, downloaded_size=total_size WHERE id=?",
      ).run(cached, downloadId)
      attempts.delete(downloadId)
      breaker.recordSuccess()
      win()?.webContents.send('download:complete', { id: downloadId, cached: true })
      onInstall?.(downloadId)
      return
    }

    // Register the task BEFORE any await: pump()'s concurrency check counts it
    // immediately (no over-scheduling past maxConcurrent) and pause/cancel during
    // link resolution find a live AbortController instead of a "ghost" download.
    const ac = new AbortController()
    activeDownloads.set(downloadId, { id: downloadId, abortController: ac })

    try {
      // Link resolution is INSIDE the retry try: a transient 429/5xx or socket error
      // from the Nexus download_link endpoint (now carrying its status via
      // DownloadLinkError) is classified retryable and re-enqueued with backoff, instead
      // of failing the download permanently. A 401/403/404 stays a definitive failure.
      const url = await resolveUrl(row, ac.signal)
      if (ac.signal.aborted) throw new Error('annullato')
      db.prepare("UPDATE downloads SET status='downloading', error=NULL WHERE id=?").run(downloadId)

      // Stable archive name (mod name + file_id) so a resumed attempt targets the
      // SAME .part and different files of one mod never share a path.
      const ext = guessExtension(url)
      const destPath = join(downloadsDir, `${archiveBaseName(row)}${ext}`)

      // The streamer flushes ~every 250ms: that cadence drives the IPC progress
      // events, but SQLite persistence is throttled further (~1s per download) —
      // the on-disk row is a resume checkpoint, not a live progress bar, and with
      // 8 concurrent downloads this cuts WAL writes from ~32/s to ~8/s.
      const updateProgress = db.prepare('UPDATE downloads SET downloaded_size=? WHERE id=?')
      const updateTotal = db.prepare('UPDATE downloads SET total_size=? WHERE id=?')
      let knownTotal = 0
      let lastBytes = -1 // -1 → first flush initialises the speed baseline
      let lastTs = Date.now()
      let lastDbWrite = 0

      const result = await streamToFile({
        url,
        destPath,
        http: axiosGet,
        signal: ac.signal,
        // Idle guard: abort + retry a socket that connects then goes silent (no headers
        // or no bytes) past this window, rather than wedging a queue slot forever.
        // 30 s floor: a body-idle abort is driven by consumed-byte cadence, which disk
        // backpressure can pause on a healthy transfer — too low a value would false-trip
        // under heavy concurrent writes to one slow disk.
        stallTimeoutMs: Math.max(30_000, Number(store.get('downloadStallTimeoutMs')) || 120_000),
        onProgress: (downloaded, total) => {
          if (total > 0 && total !== knownTotal) {
            knownTotal = total
            updateTotal.run(total, downloadId)
          }
          const now = Date.now()
          if (now - lastDbWrite >= 1000) {
            lastDbWrite = now
            updateProgress.run(downloaded, downloadId)
          }
          // First flush of a resumed .part: baseline only, no fake multi-GB/s spike.
          const dt = (now - lastTs) / 1000
          const speed = lastBytes >= 0 && dt > 0 ? Math.round((downloaded - lastBytes) / dt) : 0
          lastTs = now
          lastBytes = downloaded
          win()?.webContents.send('download:progress', {
            id: downloadId,
            downloaded,
            total,
            percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            speed,
          })
        },
      })

      // streamToFile streams to <dest>.part, verifies the byte count, and atomically
      // promotes it — a truncated transfer never reaches the extractor.
      db.prepare(
        "UPDATE downloads SET status='completed', file_path=?, downloaded_size=?, total_size=? WHERE id=?",
      ).run(destPath, result.bytes, result.total || result.bytes, downloadId)
      activeDownloads.delete(downloadId)
      attempts.delete(downloadId)
      breaker.recordSuccess() // a success breaks the failure streak
      logger.info(
        'download',
        `Completato "${row.name}" (${result.bytes} byte${result.resumed ? ', ripreso' : ''})`,
      )
      win()?.webContents.send('download:complete', { id: downloadId })
      onInstall?.(downloadId) // hand off to extraction/install pipeline
    } catch (err: unknown) {
      const msg = (err as Error).message
      activeDownloads.delete(downloadId)

      // User-initiated pause/cancel is judged by THIS download's signal state, not by
      // the error text: a resolve-phase abort throws the Italian 'annullato' (which the
      // old 'abort'/'canceled' substring check missed → mis-marked failed), while the
      // retryable 'ECONNABORTED' socket code contains the substring 'abort' (→ was wrongly
      // parked as a pause and never retried). Signal state is authoritative and must be
      // handled BEFORE the breaker so a pause never counts as a failure.
      if (ac.signal.aborted) {
        db.prepare("UPDATE downloads SET status='paused', error=? WHERE id=?").run(msg, downloadId)
        win()?.webContents.send('download:error', { id: downloadId, error: msg })
        return
      }

      const tried = (attempts.get(downloadId) ?? 0) + 1
      attempts.set(downloadId, tried)
      breaker.recordFailure()
      logger.warn('download', `"${row.name}" tentativo ${tried} fallito: ${msg}`)

      // Circuit breaker (shared policy): a systemic failure (offline, expired key)
      // shouldn't burn through every queued item. Halt the queue past the threshold.
      if (breaker.isOpen()) {
        queueHalted = true
        logger.error('download', `Soglia errori (${errorThreshold()}) superata — coda sospesa`)
        win()?.webContents.send('download:queue-halted', { errors: breaker.failures })
      }

      // Retry ONLY classified-transient errors (429/5xx/ECONNRESET/ECONNABORTED/ESTALLED/
      // TLS/CF), with jittered backoff; a tripped breaker forces a definitive failure.
      const outcome = classifyDownloadFailure({
        aborted: false, // already handled above
        err,
        tried,
        maxRetries: maxRetries(),
        breakerOpen: queueHalted,
      })
      if (outcome === 'retry') {
        const backoff = backoffWithJitter(tried - 1) // jittered 0.5s,1s,2s… capped 8s
        db.prepare("UPDATE downloads SET status='pending', error=? WHERE id=?").run(
          `Tentativo ${tried}/${maxRetries()}: ${msg}`,
          downloadId,
        )
        setTimeout(() => enqueue(downloadId), backoff)
      } else {
        attempts.delete(downloadId) // definitive failure: don't leak the counter
        db.prepare("UPDATE downloads SET status='failed', error=? WHERE id=?").run(msg, downloadId)
        win()?.webContents.send('download:error', { id: downloadId, error: msg })
      }
    }
  }

  // Pump the queue: keep up to maxConcurrent downloads running; when one settles,
  // pump again so the next pending item starts automatically.
  function pump() {
    if (queueHalted) return
    while (activeDownloads.size < maxConcurrent() && queue.length > 0) {
      const id = queue.shift()!
      if (activeDownloads.has(id)) continue
      startDownload(id).finally(() => pump())
    }
  }

  function enqueue(id: number) {
    if (!queue.includes(id) && !activeDownloads.has(id)) queue.push(id)
    pump()
  }

  // Any explicit user action (resume / re-process) clears the circuit breaker.
  function resetBreaker() {
    queueHalted = false
    breaker.reset()
  }

  function processPending() {
    resetBreaker()
    const rows = db
      .prepare("SELECT id FROM downloads WHERE status='pending' ORDER BY created_at ASC")
      .all() as { id: number }[]
    rows.forEach((r) => enqueue(r.id))
    return { queued: rows.length }
  }

  // ─── IPC ──────────────────────────────────────────────────────────────────
  ipcMain.handle('download:start', (_e, downloadId: number) => {
    enqueue(downloadId)
  })
  ipcMain.handle('download:enqueue', (_e, downloadId: number) => {
    enqueue(downloadId)
  })
  ipcMain.handle('download:process-pending', () => processPending())

  ipcMain.handle('download:pause', (_e, downloadId: number) => {
    activeDownloads.get(downloadId)?.abortController.abort()
  })

  ipcMain.handle('download:resume', (_e, downloadId: number) => {
    resetBreaker()
    attempts.delete(downloadId)
    // Keep any existing .part: the streamer resumes from it via an HTTP Range request.
    db.prepare("UPDATE downloads SET status='pending' WHERE id=?").run(downloadId)
    enqueue(downloadId)
  })

  // Delete every on-disk artifact for this download (final archive AND any .part), so
  // a cancel can never leave a stale partial that a same-named download would resume.
  // Matches EXACT candidate names (base+ext / base+ext.part), never a bare prefix:
  // "Mod A" must not wipe the archives of "Mod A HD Patch".
  function removeArtifacts(row: DownloadRow) {
    const base = archiveBaseName(row)
    for (const ext of ['.7z', '.zip', '.rar', '.exe']) {
      for (const candidate of [`${base}${ext}`, `${base}${ext}.part`]) {
        try {
          unlinkSync(join(downloadsDir, candidate))
        } catch {
          /* not there / in use */
        }
      }
    }
  }

  ipcMain.handle('download:cancel', async (_e, downloadId: number) => {
    const idx = queue.indexOf(downloadId)
    if (idx >= 0) queue.splice(idx, 1)
    activeDownloads.get(downloadId)?.abortController.abort()
    attempts.delete(downloadId)
    const row = getRow(downloadId)
    // The write stream may hold the .part for a beat after abort(): retry once
    // shortly after, then give up quietly (the size check ignores stale leftovers).
    if (row) {
      removeArtifacts(row)
      setTimeout(() => removeArtifacts(row), 500)
    }
    db.prepare('DELETE FROM downloads WHERE id=?').run(downloadId)
  })

  ipcMain.handle('download:active-count', () => activeDownloads.size)

  return { enqueue, processPending }
}
