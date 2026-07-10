import type { SignedManifest } from './manifest'
import {
  fetchSignedJson,
  isHostAllowed,
  DEFAULT_ARTIFACT_HOSTS,
  type FetchSignedJsonOptions,
} from '../net/fetchSignedJson'

// Safe transport for the signed remote catalog (Act-03). The generic SSRF-hardened
// retrieval lives in ../net/fetchSignedJson (shared with the reference mod catalog);
// this module only pins the manifest-specific defaults and structural shape. The TRUST
// boundary (Ed25519 signature, monotonic counter, download_url host allow-list) stays
// in DeltaService.ingest — fetched bytes are never trusted until verified there.

export type FetchCatalogOptions = FetchSignedJsonOptions

// Re-exported so the manifest host-allow-list check and its unit tests keep a single
// import site for the shared matcher.
export { isHostAllowed }

// Default hosts where a signed catalog may legitimately live (release artifacts).
// Override at the call site via env (NOLVUS_CATALOG_HOSTS).
export const DEFAULT_MANIFEST_HOSTS = DEFAULT_ARTIFACT_HOSTS

export function fetchSignedManifest(rawUrl: string, opts: FetchCatalogOptions): Promise<SignedManifest> {
  return fetchSignedJson(rawUrl, opts, (parsed) => {
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
  })
}
