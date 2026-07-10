import { canonicalJSON } from './canonicalJson'
import { verifyEd25519Signed } from './signature'

// ── Trust boundary on the remote manifest (fixes C1 RCE + M3 replay). ─────────
// The manifest is UNTRUSTED input. Before any of its data is used we require:
//   1. its sha256 matches the embedded digest (integrity),
//   2. a valid Ed25519 signature over the canonical bytes from the PINNED key
//      (authenticity — blocks a compromised repo / MITM publishing archives),
//   3. a strictly monotonic release_counter (anti-replay / anti-downgrade),
//   4. every download_url on an allow-listed host (no arbitrary fetch/extract).
// Any failure ⇒ the whole manifest is rejected; nothing is downloaded.

export interface ManifestMod {
  nexus_id: number
  name: string
  version: string
  file_id: number
  file_name: string
  file_hash: string // sha256 of the archive, verified pre-extraction (C3)
  download_url?: string
  priority_order?: number
  category?: string
}

export interface ManifestBody {
  release_tag: string
  release_counter: number // monotonic, signed
  published_at: string
  mods: ManifestMod[]
}

export interface SignedManifest {
  manifest: ManifestBody
  sha256: string
  sig_ed25519: string // hex
}

export interface VerifyOptions {
  publicKeyPem: string
  lastCounter: number // highest release_counter already accepted
  allowedHosts: RegExp[]
}

export interface VerifyResult {
  ok: boolean
  manifest?: ManifestBody
  error?: string
}

const fail = (error: string): VerifyResult => ({ ok: false, error })

export function verifyManifest(signed: SignedManifest, opts: VerifyOptions): VerifyResult {
  try {
    if (!signed || typeof signed !== 'object') return fail('manifest assente')
    if (!signed.manifest || typeof signed.sha256 !== 'string' || typeof signed.sig_ed25519 !== 'string') {
      return fail('manifest malformato (manca manifest/sha256/sig)')
    }

    const payload = Buffer.from(canonicalJSON(signed.manifest), 'utf8')

    // (1) integrity + (2) authenticity — shared sha256 + pinned Ed25519 primitive.
    const sig = verifyEd25519Signed(payload, signed.sha256, signed.sig_ed25519, opts.publicKeyPem)
    if (!sig.ok) {
      if (sig.stage === 'integrity') return fail('hash manifest non coerente con il contenuto')
      if (sig.stage === 'key') return fail('chiave pubblica non valida')
      return fail('firma Ed25519 non valida (manifest non attendibile)')
    }

    // (3) anti-replay / anti-downgrade
    const counter = signed.manifest.release_counter
    if (typeof counter !== 'number' || !Number.isInteger(counter))
      return fail('release_counter mancante o non intero')
    if (counter <= opts.lastCounter)
      return fail(`replay/downgrade: counter ${counter} <= ${opts.lastCounter}`)

    // (4) host allow-list on every download_url
    const mods = Array.isArray(signed.manifest.mods) ? signed.manifest.mods : []
    for (const m of mods) {
      if (m.download_url && !opts.allowedHosts.some((r) => r.test(m.download_url!))) {
        return fail(`host download non consentito: ${m.download_url}`)
      }
    }

    return { ok: true, manifest: signed.manifest }
  } catch (e) {
    return fail((e as Error).message)
  }
}

// Default allow-list: only Nexus CDN / Nexus file hosts. Kept here so it is unit
// tested and shared between main process and tests.
export const DEFAULT_ALLOWED_HOSTS: RegExp[] = [
  /^https:\/\/[\w.-]*\.nexus-cdn\.com\//i,
  /^https:\/\/[\w.-]*\.nexusmods\.com\//i,
  /^https:\/\/files\.nexusmods\.com\//i,
]
