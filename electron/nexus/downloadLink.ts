// Nexus "download_link" resolver — turns (mod_id, file_id) into a direct CDN URL.
//
// Auth: Nexus personal API keys travel in the `apikey` header; OAuth access tokens
// travel in `Authorization: Bearer <token>`. We support both (Bearer wins if given).
// Premium accounts may call download_link.json directly; non-premium must pass the
// `key`+`expires` pair handed out by an nxm:// link (manual download), forwarded here
// as query params. Pure + http-injected so it is fully unit-testable.

export interface JsonResponse {
  status?: number
  data: unknown
}
export type HttpGetJson = (
  url: string,
  cfg: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<JsonResponse>

export interface DownloadLinkParams {
  modId: number
  fileId: number
  game?: string // default 'skyrimspecialedition'
  apiKey?: string
  bearerToken?: string // OAuth alternative to apiKey
  key?: string // nxm link token (non-premium manual download)
  expires?: number | string
  userAgent?: string
  signal?: AbortSignal
}

export function buildDownloadLinkRequest(p: DownloadLinkParams): {
  url: string
  headers: Record<string, string>
} {
  const game = p.game ?? 'skyrimspecialedition'
  const base = `https://api.nexusmods.com/v1/games/${game}/mods/${p.modId}/files/${p.fileId}/download_link.json`
  const qs = new URLSearchParams()
  if (p.key) qs.set('key', p.key)
  if (p.expires != null && p.expires !== '') qs.set('expires', String(p.expires))
  const url = qs.toString() ? `${base}?${qs.toString()}` : base

  const headers: Record<string, string> = {
    'User-Agent': p.userAgent ?? 'SkyrimAEModManager/1.0',
    Accept: 'application/json',
  }
  if (p.bearerToken) headers.Authorization = `Bearer ${p.bearerToken}`
  else if (p.apiKey) headers.apikey = p.apiKey
  return { url, headers }
}

/** Nexus returns an array of { name, short_name, URI }. Pick the first usable URI. */
export function parseDownloadLink(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0)
    throw new Error('Nexus non ha restituito alcun link di download')
  const hit = data.find((l) => l && typeof (l as { URI?: unknown }).URI === 'string') as
    { URI?: string } | undefined
  if (!hit?.URI) throw new Error('Risposta Nexus priva di un URI valido')
  return hit.URI
}

function httpStatus(e: unknown): number | undefined {
  const x = e as { status?: number; response?: { status?: number } }
  return x?.status ?? x?.response?.status
}

/**
 * A resolve failure that PRESERVES the HTTP status (and the original error as `cause`)
 * so the shared retry policy can classify it: without this the friendly Italian message
 * was thrown as a bare Error with no status, and a transient 429/5xx (or a socket error)
 * during link resolution was misread as permanent and never retried.
 */
export class DownloadLinkError extends Error {
  readonly status?: number
  readonly cause?: unknown
  constructor(message: string, status: number | undefined, cause?: unknown) {
    super(message)
    this.name = 'DownloadLinkError'
    this.status = status
    if (cause !== undefined) this.cause = cause // preserve original code/message for retry classification
  }
}

export async function resolveDownloadLink(http: HttpGetJson, p: DownloadLinkParams): Promise<string> {
  if (!p.apiKey && !p.bearerToken && !p.key) {
    throw new Error('Nessuna credenziale Nexus: configura la API key (o usa un link nxm con key/expires)')
  }
  const { url, headers } = buildDownloadLinkRequest(p)
  try {
    const res = await http(url, { headers, signal: p.signal })
    return parseDownloadLink(res.data)
  } catch (e) {
    const status = httpStatus(e)
    // Friendly, actionable message — but keep `status` + `cause` on the error so
    // withRetry/isRetryableError see a 429/5xx (retryable) or the underlying socket code.
    if (status === 401 || status === 403) {
      throw new DownloadLinkError(
        'Download diretto rifiutato (401/403): richiede Nexus Premium, oppure usa un link nxm con key/expires',
        status,
        e,
      )
    }
    if (status === 404)
      throw new DownloadLinkError('File non trovato su Nexus (mod/file id errati o rimosso)', status, e)
    if (status === 429)
      throw new DownloadLinkError('Limite richieste Nexus superato (429): riprova più tardi', status, e)
    throw new DownloadLinkError(
      `Nexus download_link fallito${status ? ` (HTTP ${status})` : ''}: ${(e as Error).message}`,
      status,
      e,
    )
  }
}
