import type { SignedManifest } from './manifest'

// Safe transport for the signed remote catalog (Act-03). This module ONLY does the
// network retrieval with strict guards; the TRUST boundary (Ed25519 signature,
// monotonic counter, download_url host allow-list) stays in DeltaService.ingest, so
// fetched bytes are never trusted until verified there.
//
// SSRF / abuse defenses (fail-closed):
//   • parse with new URL() and match url.hostname against an explicit allow-list
//     (never substring-match the raw URL — that is bypassable),
//   • restrict the protocol (https only by default),
//   • reject redirects (a trusted host must not bounce us to an internal one),
//   • cap the body size (Content-Length + actual bytes) and apply a timeout.

export interface FetchCatalogOptions {
  allowedHosts: string[] // exact hostnames, or '.example.com' to match subdomains
  allowProtocols?: string[] // default ['https:']
  maxBytes?: number // default 2 MB
  timeoutMs?: number // default 10 s
  fetchImpl?: typeof fetch // injectable for tests
}

// Default hosts where a signed catalog may legitimately live (release artifacts).
// Override at the call site via env (NOLVUS_CATALOG_HOSTS).
export const DEFAULT_MANIFEST_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
]

export function isHostAllowed(hostname: string, allow: string[]): boolean {
  const h = hostname.toLowerCase()
  return allow.some((a) => {
    const x = a.toLowerCase()
    return x.startsWith('.') ? h === x.slice(1) || h.endsWith(x) : h === x
  })
}

export async function fetchSignedManifest(
  rawUrl: string,
  opts: FetchCatalogOptions,
): Promise<SignedManifest> {
  const protocols = opts.allowProtocols ?? ['https:']
  const maxBytes = opts.maxBytes ?? 2_000_000
  const timeoutMs = opts.timeoutMs ?? 10_000
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('fetch non disponibile in questo runtime')

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`URL catalogo non valido: ${rawUrl}`)
  }
  if (!protocols.includes(url.protocol)) throw new Error(`protocollo non consentito: ${url.protocol}`)
  if (!isHostAllowed(url.hostname, opts.allowedHosts))
    throw new Error(`host catalogo non consentito: ${url.hostname}`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await doFetch(url.toString(), {
      signal: ctrl.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    })
  } catch (e) {
    throw new Error(`fetch catalogo fallito: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(`catalogo HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared && declared > maxBytes)
    throw new Error(`catalogo troppo grande: ${declared} > ${maxBytes} byte`)

  const text = await res.text()
  if (text.length > maxBytes) throw new Error(`catalogo troppo grande: ${text.length} > ${maxBytes} byte`)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('catalogo non è JSON valido')
  }

  // Structural sanity only — signature/counter/host trust checks happen in ingest.
  const sm = parsed as SignedManifest
  if (
    !sm ||
    typeof sm !== 'object' ||
    !sm.manifest ||
    typeof sm.sig_ed25519 !== 'string' ||
    typeof sm.sha256 !== 'string'
  ) {
    throw new Error('catalogo malformato (manca manifest/sha256/sig)')
  }
  return sm
}
