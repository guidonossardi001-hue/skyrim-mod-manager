import { canonicalJSON } from '../delta/canonicalJson'
import { verifyEd25519Signed } from '../delta/signature'
import { checkFreshness } from '../net/freshness'
import type { SignedCatalog, ModCatalog, CatalogErrorKind } from './types'

// Thin shell over the SAME trust-boundary primitives as ../delta/manifest.ts
// (sha256 integrity, pinned Ed25519 authenticity, monotonic counter). Kept as
// its own module (not a re-export) because the signed field is catalog_version,
// not release_counter, and there is no download_url host allow-list here — the
// reference catalog carries no download URLs, only nexus_id/name/metadata.

export interface VerifyCatalogOptions {
  publicKeyPem: string
  lastVersion: number // highest catalog_version already accepted (fold the pinned floor in first)
  lastGeneratedAt?: string | null // generated_at of the last accepted catalog (anti-rollback axis 2)
  now?: number // enables the future-skew guard
}

export interface VerifyCatalogResult {
  ok: boolean
  catalog?: ModCatalog
  error?: string
  kind?: CatalogErrorKind
  freshness?: boolean // true when the rejection was an anti-rollback/freshness violation
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

    // (3) anti-replay / anti-downgrade — monotonic catalog_version AND non-regressing generated_at.
    const fresh = checkFreshness(
      { counter: signed.catalog.catalog_version, publishedAt: signed.catalog.generated_at },
      { lastCounter: opts.lastVersion, lastPublishedAt: opts.lastGeneratedAt ?? null },
      { now: opts.now, counterLabel: 'version' },
    )
    if (!fresh.ok) {
      // catalog_version parse failure keeps its schema kind; a real rollback is 'downgrade'.
      const kind: CatalogErrorKind = /mancante o non intero/.test(fresh.reason) ? 'schema' : 'downgrade'
      return { ok: false, kind, error: fresh.reason, freshness: true }
    }

    return { ok: true, catalog: signed.catalog }
  } catch (e) {
    return fail('parse', (e as Error).message)
  }
}
