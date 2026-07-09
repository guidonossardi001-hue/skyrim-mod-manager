import { createWriteStream, existsSync, renameSync, statSync } from 'fs'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'

// Resumable streaming download for heavy mod archives. The bytes are streamed to a
// `<dest>.part` sidecar (never buffered) and the file is only promoted to its final
// name once complete, so a partial/interrupted transfer is never mistaken for a
// finished archive. If a `.part` already exists we resume with an HTTP Range request
// (huge bandwidth saving on multi-GB files); a server that ignores Range and replies
// 200 simply restarts cleanly. The HTTP client is injected so this is unit-testable
// against a real local server.

export interface RangePlan {
  append: boolean
  startOffset: number
}
export interface StreamResult {
  bytes: number
  total: number
  resumed: boolean
}

export interface HttpStreamResponse {
  status: number
  headers: Record<string, unknown>
  data: Readable
}
export interface HttpGet {
  (
    url: string,
    cfg: {
      responseType: 'stream'
      headers?: Record<string, string>
      signal?: AbortSignal
      validateStatus?: (s: number) => boolean
    },
  ): Promise<HttpStreamResponse>
}

export interface StreamToFileOptions {
  url: string
  destPath: string
  http: HttpGet
  signal?: AbortSignal
  onProgress?: (downloaded: number, total: number) => void
  progressIntervalMs?: number
  // Idle/stall guard: if the server accepts the socket but then sends NO response
  // headers (connect phase) or NO body bytes (transfer phase) for this many ms, the
  // transfer is aborted with a retryable StallError instead of hanging forever. The
  // .part survives so the next attempt resumes via Range. Default 120 s.
  stallTimeoutMs?: number
}

/**
 * A connected-but-idle socket: headers or body bytes stopped arriving past the stall
 * timeout. Carries code 'ESTALLED' so the shared retry policy classifies it as a
 * transient, retryable failure (NOT a user cancel — that stays an AbortError).
 */
export class StallError extends Error {
  readonly code = 'ESTALLED'
  constructor(message: string) {
    super(message)
    this.name = 'StallError'
  }
}

/** Content-Range: "bytes 200-1023/1024" → {start,end,total}. */
export function parseContentRange(header?: unknown): { start: number; end: number; total: number } | null {
  if (typeof header !== 'string') return null
  const m = header.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i)
  return m ? { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) } : null
}

/** Decide append-vs-restart from the partial size and the server's response status. */
export function planResume(partSize: number, status: number): RangePlan {
  // 206 honours our Range → append; anything else (200) means a full body → restart.
  return status === 206 && partSize > 0
    ? { append: true, startOffset: partSize }
    : { append: false, startOffset: 0 }
}

export async function streamToFile(opts: StreamToFileOptions): Promise<StreamResult> {
  const part = opts.destPath + '.part'
  const partSize = existsSync(part) ? statSync(part).size : 0

  const headers: Record<string, string> = {}
  if (partSize > 0) headers.Range = `bytes=${partSize}-`

  const stallMs = opts.stallTimeoutMs ?? 120_000

  // Internal controller: aborts the underlying request on EITHER the caller's cancel
  // (mirrored below) OR a stall. `stalled` distinguishes the two so a timeout surfaces
  // as a retryable StallError while a user cancel stays an AbortError.
  const ac = new AbortController()
  let stalled: string | null = null
  const tripStall = (why: string) => {
    if (stalled === null) stalled = why
    ac.abort()
  }
  // Mirror the caller's cancel onto our internal controller. The handler is REMOVED in
  // the finally below: mass-sync shares ONE run-wide signal across thousands of mods, so
  // a per-download listener that lingered would leak closures and trip MaxListenersExceeded.
  const onExternalAbort = () => ac.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    // 416 = il Range parte oltre la fine del file: il .part è GIÀ completo (crash
    // dopo il download ma prima della promozione). Senza questo caso il download
    // resterebbe bloccato per sempre: 416 è un 4xx che la retry policy non ritenta.
    //
    // Connect/header phase is RACED against the stall timer: a server that accepts the
    // socket but never sends headers can't hang the request forever (the timer wins the
    // race and rejects even if the http client ignores the abort signal).
    const reqPromise = opts.http(opts.url, {
      responseType: 'stream',
      headers,
      signal: ac.signal,
      validateStatus: (s) => s === 200 || s === 206 || (s === 416 && partSize > 0),
    })
    reqPromise.catch(() => {}) // race-loser guard: swallow the abort rejection if the timer wins
    let headerTimer: ReturnType<typeof setTimeout> | undefined
    let res: HttpStreamResponse
    try {
      res = await Promise.race([
        reqPromise,
        new Promise<never>((_, reject) => {
          headerTimer = setTimeout(() => {
            tripStall(`nessuna risposta dal server entro ${stallMs}ms`)
            reject(new StallError(`Download stallato: nessuna risposta dal server entro ${stallMs}ms`))
          }, stallMs)
        }),
      ])
    } finally {
      if (headerTimer) clearTimeout(headerTimer)
    }
    if (res.status === 416) {
      res.data.resume?.() // scarta l'eventuale corpo d'errore
      const cr = parseContentRange(res.headers['content-range']) // 416 → "bytes */<total>"
      const total =
        typeof res.headers['content-range'] === 'string'
          ? Number((res.headers['content-range'] as string).match(/\/(\d+)$/)?.[1] ?? 0)
          : (cr?.total ?? 0)
      if (total > 0 && partSize !== total) {
        throw new Error(`Ripresa impossibile: .part di ${partSize} byte oltre la dimensione remota ${total}`)
      }
      renameSync(part, opts.destPath)
      opts.onProgress?.(partSize, partSize)
      return { bytes: partSize, total: total || partSize, resumed: true }
    }

    const plan = planResume(partSize, res.status)
    const contentLength = Number(res.headers['content-length'] ?? 0)
    const cr = parseContentRange(res.headers['content-range'])
    const total = cr?.total ?? (plan.append ? plan.startOffset + contentLength : contentLength)

    let downloaded = plan.startOffset
    const interval = opts.progressIntervalMs ?? 250
    let last = 0

    // Body-idle watchdog: rearmed on every chunk. If bytes stop flowing for stallMs the
    // request is aborted (via ac) and the pipeline rejects — caught below as a StallError.
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => tripStall(`nessun dato ricevuto per ${stallMs}ms`), stallMs)
    }

    res.data.on('data', (c: Buffer) => {
      armIdle() // fresh bytes → reset the stall clock
      downloaded += c.length
      const now = Date.now()
      if (now - last >= interval) {
        last = now
        opts.onProgress?.(downloaded, total)
      }
    })

    // pipeline() destroys streams on error and rejects — the .part is left in place so
    // a later attempt can resume from it. On abort (user cancel OR stall) the partial
    // likewise survives; the ac.signal lets a stall actually tear the pipeline down.
    const writer = createWriteStream(part, { flags: plan.append ? 'a' : 'w' })
    armIdle()
    try {
      await pipeline(res.data, writer, { signal: ac.signal })
    } catch (e) {
      if (stalled !== null) throw new StallError(`Download stallato: ${stalled}`)
      throw e // user cancel (AbortError) or a genuine stream error — bubble unchanged
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
    }

    opts.onProgress?.(downloaded, total)
    // Byte-count gate needs a declared size. A server that sends neither Content-Length
    // nor Content-Range (total === 0) gives no completeness signal, so a graceful early
    // close cannot be told from a full body here — the archive extractor's own integrity
    // check is the backstop, and the Nexus path (which carries Content-Length + an md5
    // verified by the caller) never reaches this blind spot.
    if (total > 0 && downloaded !== total) {
      throw new Error(`Download incompleto: ${downloaded}/${total} byte`)
    }

    renameSync(part, opts.destPath) // atomic promote: only a COMPLETE file gets the final name
    return { bytes: downloaded, total, resumed: plan.append }
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }
}
