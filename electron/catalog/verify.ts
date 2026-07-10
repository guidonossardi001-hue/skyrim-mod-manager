import { canonicalJSON } from '../delta/canonicalJson'
import { verifyEd25519Signed } from '../delta/signature'
import type { SignedCatalog, ModCatalog, CatalogErrorKind } from './types'

// Thin shell over the SAME trust-boundary primitives as ../delta/manifest.ts
// (sha256 integrity, pinned Ed25519 authenticity, monotonic counter). Kept as
// its own module (not a re-export) because the signed field is catalog_version,
// not release_counter, and there is no download_url host allow-list here — the
// reference catalog carries no download URLs, only nexus_id/name/metadata.

export interface VerifyCatalogOptions {
  publicKeyPem: string
  lastVersion: number // highest catalog_version already accepted
}

export interface VerifyCatalogResult {
  ok: boolean
  catalog?: ModCatalog
  error?: string
  kind?: CatalogErrorKind
}

const fail = (kind: CatalogErrorKind, error: string): VerifyCatalogResult => ({ ok: false, kind, error })

export function verifyCatalog(signed: SignedCatalog, opts: VerifyCatalogOptions): VerifyCatalogResult {
  try {
    if (!signed || typeof signed !== 'object') return fail('parse', 'catalogo assente')
    if (!signed.catalog || typeof signed.sha256 !== 'string' || typeof signed.sig_ed25519 !== 'string') {
      return fail('parse', 'catalogo malformato (manca catalog/sha256/sig)')
    }

    const payload = Buffer.from(canonicalJSON(signed.catalog), 'utf8')

    // (1) integrity + (2) authenticity — shared sha256 + pinned Ed25519 primitive.
    const sig = verifyEd25519Signed(payload, signed.sha256, signed.sig_ed25519, opts.publicKeyPem)
    if (!sig.ok) {
      if (sig.stage === 'integrity') return fail('integrity', 'hash catalogo non coerente con il contenuto')
      if (sig.stage === 'key') return fail('signature', 'chiave pubblica non valida')
      return fail('signature', 'firma Ed25519 non valida (catalogo non attendibile)')
    }

    // (3) anti-replay / anti-downgrade
    const version = signed.catalog.catalog_version
    if (typeof version !== 'number' || !Number.isInteger(version))
      return fail('schema', 'catalog_version mancante o non intero')
    if (version <= opts.lastVersion)
      return fail('downgrade', `replay/downgrade: version ${version} <= ${opts.lastVersion}`)

    return { ok: true, catalog: signed.catalog }
  } catch (e) {
    return fail('parse', (e as Error).message)
  }
}
