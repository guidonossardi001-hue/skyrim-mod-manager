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
