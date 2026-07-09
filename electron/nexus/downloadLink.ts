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
  return (e as { response?: { status?: number } })?.response?.status
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
    if (status === 401 || status === 403) {
      throw new Error(
        'Download diretto rifiutato (401/403): richiede Nexus Premium, oppure usa un link nxm con key/expires',
      )
    }
    if (status === 404) throw new Error('File non trovato su Nexus (mod/file id errati o rimosso)')
    if (status === 429) throw new Error('Limite richieste Nexus superato (429): riprova più tardi')
    throw new Error(
      `Nexus download_link fallito${status ? ` (HTTP ${status})` : ''}: ${(e as Error).message}`,
    )
  }
}
