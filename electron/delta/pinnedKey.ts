// Real Ed25519 release public key (the manifest signer). Overridable via the
// NOLVUS_MANIFEST_PUBKEY env var for key rotation without a rebuild. The matching
// PRIVATE key lives ONLY in the CI secret store (secrets/ is gitignored).
// Electron-free so the verification path is unit-testable end to end.

export const EMBEDDED_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAdvvGYIU3c6KD7UkkD8P8yTFdBwS0b+31vg8JDs8OfA8=\n' +
  '-----END PUBLIC KEY-----\n'

export function pinnedPublicKey(): string {
  const proc = typeof process !== 'undefined' ? process.env : undefined
  const env = proc?.NOLVUS_MANIFEST_PUBKEY
  // The env override is a dev/CI/test convenience for key rotation. A user-writable
  // env var must NOT be able to replace the trust anchor in a SHIPPED build — that
  // would let a local attacker set NOLVUS_MANIFEST_PUBKEY to their own key and have
  // every forged manifest verify. So honor the override only outside production;
  // packaged builds always pin the embedded key. Production key rotation must ship a
  // new build (or a future signed key-rotation manifest), not rely on an env var.
  const mode = proc?.NODE_ENV
  const overrideAllowed = mode === 'development' || mode === 'test' || mode === 'ci'
  return overrideAllowed && env && env.includes('BEGIN PUBLIC KEY') ? env : EMBEDDED_PUBLIC_KEY_PEM
}

// ── Anti-rollback build-time floor (TOFU defense) ─────────────────────────────
// The freshness floor = the release SHIPPED in this build. Folded into the DB baseline so a
// fresh install cannot be tricked into ingesting an update OLDER than the executable itself
// (a MITM replaying an old-but-validly-signed manifest at first launch). Bump BOTH constants
// to the shipped release at every build — ideally wired into the signing/publish script.
export interface PinnedFloor {
  counter: number
  publishedAt: string | null
}

// Delta release manifest floor (release_counter / published_at of the shipped release).
export const PINNED_MANIFEST_FLOOR: PinnedFloor = { counter: 2, publishedAt: '2026-06-24T00:00:00Z' }
// Reference mod catalog floor (catalog_version / generated_at of the shipped catalog).
export const PINNED_CATALOG_FLOOR: PinnedFloor = { counter: 1, publishedAt: '2026-06-22T00:00:00Z' }

const ZERO_FLOOR: PinnedFloor = { counter: 0, publishedAt: null }

function isProdLike(proc: NodeJS.ProcessEnv | undefined): boolean {
  const mode = proc?.NODE_ENV
  return !(mode === 'development' || mode === 'test' || mode === 'ci')
}

/** Parse a `{"counter":N,"publishedAt":"ISO"}` env override (dev/CI/test only). */
function parseEnvFloor(raw: string | undefined): PinnedFloor | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<PinnedFloor>
    if (typeof o?.counter !== 'number' || !Number.isInteger(o.counter)) return null
    return { counter: o.counter, publishedAt: typeof o.publishedAt === 'string' ? o.publishedAt : null }
  } catch {
    return null
  }
}

function pinnedFloor(prodValue: PinnedFloor, envVar: string): PinnedFloor {
  const proc = typeof process !== 'undefined' ? process.env : undefined
  // Production always pins the shipped floor — a user-writable env var must never lower it.
  // Outside production, an env override (or a zero floor) keeps dev/tests unencumbered.
  if (isProdLike(proc)) return prodValue
  return parseEnvFloor(proc?.[envVar]) ?? ZERO_FLOOR
}

export function pinnedManifestFloor(): PinnedFloor {
  return pinnedFloor(PINNED_MANIFEST_FLOOR, 'NOLVUS_MANIFEST_FLOOR')
}

export function pinnedCatalogFloor(): PinnedFloor {
  return pinnedFloor(PINNED_CATALOG_FLOOR, 'NOLVUS_CATALOG_FLOOR')
}
