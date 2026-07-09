// Real Ed25519 release public key (the manifest signer). Overridable via the
// NOLVUS_MANIFEST_PUBKEY env var for key rotation without a rebuild. The matching
// PRIVATE key lives ONLY in the CI secret store (secrets/ is gitignored).
// Electron-free so the verification path is unit-testable end to end.

export const EMBEDDED_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAdvvGYIU3c6KD7UkkD8P8yTFdBwS0b+31vg8JDs8OfA8=\n' +
  '-----END PUBLIC KEY-----\n'

export function pinnedPublicKey(): string {
  const env = typeof process !== 'undefined' ? process.env?.NOLVUS_MANIFEST_PUBKEY : undefined
  return env && env.includes('BEGIN PUBLIC KEY') ? env : EMBEDDED_PUBLIC_KEY_PEM
}
