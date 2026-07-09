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

  // 416 = il Range parte oltre la fine del file: il .part è GIÀ completo (crash
  // dopo il download ma prima della promozione). Senza questo caso il download
  // resterebbe bloccato per sempre: 416 è un 4xx che la retry policy non ritenta.
  const res = await opts.http(opts.url, {
    responseType: 'stream',
    headers,
    signal: opts.signal,
    validateStatus: (s) => s === 200 || s === 206 || (s === 416 && partSize > 0),
  })
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
  res.data.on('data', (c: Buffer) => {
    downloaded += c.length
    const now = Date.now()
    if (now - last >= interval) {
      last = now
      opts.onProgress?.(downloaded, total)
    }
  })

  // pipeline() destroys streams on error and rejects — the .part is left in place so
  // a later attempt can resume from it. On abort the partial likewise survives.
  const writer = createWriteStream(part, { flags: plan.append ? 'a' : 'w' })
  await pipeline(res.data, writer)

  opts.onProgress?.(downloaded, total)
  if (total > 0 && downloaded !== total) {
    throw new Error(`Download incompleto: ${downloaded}/${total} byte`)
  }

  renameSync(part, opts.destPath) // atomic promote: only a COMPLETE file gets the final name
  return { bytes: downloaded, total, resumed: plan.append }
}
