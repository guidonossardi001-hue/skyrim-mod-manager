import type { SignedCatalog } from './types'
import {
  fetchSignedJson,
  DEFAULT_ARTIFACT_HOSTS,
  type FetchSignedJsonOptions,
} from '../net/fetchSignedJson'

// Safe transport for the signed reference mod catalog. The generic SSRF-hardened
// retrieval lives in ../net/fetchSignedJson (shared with the delta manifest); this
// module only pins the catalog-specific defaults and structural shape. The TRUST
// boundary (Ed25519 signature, sha256 integrity, monotonic catalog_version) stays in
// CatalogService.ingest via verify.ts — fetched bytes are never trusted until verified.

export type FetchModCatalogOptions = FetchSignedJsonOptions

// Default hosts where a signed catalog may legitimately live. Override at the call
// site via NOLVUS_MOD_CATALOG_HOSTS (comma-separated) for a different CDN.
export const DEFAULT_MOD_CATALOG_HOSTS = DEFAULT_ARTIFACT_HOSTS

/**
 * Resolves the catalog URL to fetch: an explicit argument wins, otherwise the
 * NOLVUS_MOD_CATALOG_URL env var (the "predefined base URL", set at deploy/build
 * time — never hardcoded here). Returns undefined if neither is set; the caller
 * (engine.ts) turns that into a no-throw `errorKind: 'network'` result instead of
 * fetching a guessed/placeholder URL.
 */
export function resolveModCatalogUrl(explicit?: string): string | undefined {
  const env = process.env.NOLVUS_MOD_CATALOG_URL
  return explicit || (env && env.trim()) || undefined
}

export function fetchSignedCatalog(rawUrl: string, opts: FetchModCatalogOptions): Promise<SignedCatalog> {
  return fetchSignedJson(rawUrl, opts, (parsed) => {
    // Structural sanity only — signature/hash/version trust checks happen in ingest.
    const sc = parsed as SignedCatalog
    if (
      !sc ||
      typeof sc !== 'object' ||
      !sc.catalog ||
      typeof sc.sig_ed25519 !== 'string' ||
      typeof sc.sha256 !== 'string'
    ) {
      throw new Error('catalogo malformato (manca catalog/sha256/sig)')
    }
    return sc
  })
}
