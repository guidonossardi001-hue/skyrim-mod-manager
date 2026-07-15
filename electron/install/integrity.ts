// Pure decision logic for the mandatory download integrity gate. No fs, no network,
// no Electron — the downloadManager computes digests / calls Nexus and feeds the results
// here, so every branch (which hash wins, match/mismatch, the md5_search fallback,
// fail-closed) is unit-testable in isolation.
//
// Two hash algorithms coexist: delta manifests are sha256; Nexus/backup archives are md5.
// An ExpectedHash therefore always carries its algorithm so the caller digests the file
// with the right one.

export type HashAlgo = 'md5' | 'sha256'

export interface ExpectedHash {
  value: string
  algo: HashAlgo
}

export function normalizeAlgo(a: string | null | undefined): HashAlgo | null {
  const s = (a ?? '').toLowerCase()
  return s === 'md5' || s === 'sha256' ? s : null
}

/** Case-insensitive hex-digest equality (both non-empty). */
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/**
 * Pick the trusted expected hash for a download, by priority:
 *   1. the download row's own file_hash/hash_algo columns (set at creation from a trusted source),
 *   2. the delta manifest's to_file_hash (always sha256),
 *   3. none → the caller must fall back to Nexus md5_search (authoritative) or fail closed.
 */
export function pickExpectedHash(candidates: {
  downloadColumn?: { value?: string | null; algo?: string | null } | null
  deltaSha256?: string | null
}): ExpectedHash | null {
  const dc = candidates.downloadColumn
  if (dc?.value) return { value: dc.value, algo: normalizeAlgo(dc.algo) ?? 'sha256' }
  if (candidates.deltaSha256) return { value: candidates.deltaSha256, algo: 'sha256' }
  return null
}

// Shape of a Nexus md5_search result entry (only the fields we trust).
export interface Md5SearchEntry {
  mod?: { mod_id?: number }
  file_details?: { file_id?: number; md5?: string }
}

/**
 * True iff the md5_search response authoritatively maps the computed md5 to the SAME
 * (modId, fileId) the user asked for — i.e. Nexus itself confirms this file is that mod's
 * file. A fileId of null (link without a specific file) only requires the mod to match.
 */
export function md5SearchConfirms(resp: unknown, want: { modId: number; fileId: number | null }): boolean {
  const arr = Array.isArray(resp) ? (resp as Md5SearchEntry[]) : []
  return arr.some((e) => {
    const m = e?.mod?.mod_id
    if (m !== want.modId) return false
    if (want.fileId != null && e?.file_details?.file_id !== want.fileId) return false
    return true
  })
}

export type IntegrityDecision =
  | { ok: true; verifiedBy: 'expected-hash' | 'md5-search' | 'api-provenance' }
  | { ok: false; reason: string }

/**
 * The gate verdict, pure over already-computed inputs. Fail-closed by construction: the ways
 * to pass are a matching trusted hash, an authoritative md5_search confirmation, or — SOLO in
 * assenza di hash atteso — la provenienza dal resolver API ufficiale Nexus (download_link.json
 * chiamato con la coppia (modId, fileId) esatta su TLS con API key: è Nexus stesso a servire
 * il file per quegli id; l'indice md5_search è notoriamente incompleto per file recenti e un
 * suo miss non può bocciare un file che Nexus ha appena consegnato per quella coppia).
 * Un URL diretto/arbitrario NON gode di questa fiducia e resta fail-closed come prima.
 */
export function decideIntegrity(input: {
  expected: ExpectedHash | null
  computed: { md5?: string | null; sha256?: string | null }
  md5SearchConfirmed?: boolean | null // null = not attempted / unavailable
  apiResolvedProvenance?: boolean // true = URL generato dal resolver API per (modId, fileId)
}): IntegrityDecision {
  const { expected, computed, md5SearchConfirmed, apiResolvedProvenance } = input
  if (expected) {
    const got = expected.algo === 'md5' ? computed.md5 : computed.sha256
    if (!got) return { ok: false, reason: `digest ${expected.algo} non calcolato` }
    return hashesEqual(got, expected.value)
      ? { ok: true, verifiedBy: 'expected-hash' }
      : {
          ok: false,
          reason: `hash ${expected.algo} non corrisponde (atteso ${expected.value.slice(0, 12)}…, ottenuto ${got.slice(0, 12)}…)`,
        }
  }
  // No trusted local hash → md5_search authoritative confirmation…
  if (md5SearchConfirmed === true) return { ok: true, verifiedBy: 'md5-search' }
  // …oppure provenienza dal canale API autenticato (il chiamante logga il declassamento).
  if (apiResolvedProvenance === true) return { ok: true, verifiedBy: 'api-provenance' }
  return {
    ok: false,
    reason: 'integrità non verificabile: nessun hash di riferimento e md5_search non conferma la provenienza',
  }
}
