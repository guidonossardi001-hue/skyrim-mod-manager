import { createHash, createPublicKey, verify } from 'crypto'

// Shared trust-boundary crypto for every signed artifact this project publishes
// (the delta manifest and the reference mod catalog): sha256 integrity over the
// canonical bytes + authenticity against a pinned Ed25519 key. Extracted so the two
// verifiers can never drift on the primitive; each caller still owns its distinct
// anti-replay counter, host allow-list, error strings and error-kind mapping via the
// returned `stage`.

export type VerifyStage = 'integrity' | 'key' | 'signature'

export type SignatureCheck = { ok: true } | { ok: false; stage: VerifyStage }

/**
 * Verify sha256 integrity then Ed25519 authenticity of `canonicalBytes`.
 *   • stage 'integrity' — the digest disagrees with the signed sha256,
 *   • stage 'key'       — the pinned public key PEM could not be parsed,
 *   • stage 'signature' — the Ed25519 signature does not verify.
 */
export function verifyEd25519Signed(
  canonicalBytes: Buffer,
  sha256Hex: string,
  sigHex: string,
  publicKeyPem: string,
): SignatureCheck {
  const digest = createHash('sha256').update(canonicalBytes).digest('hex')
  if (digest !== sha256Hex) return { ok: false, stage: 'integrity' }

  let pub
  try {
    pub = createPublicKey(publicKeyPem)
  } catch {
    return { ok: false, stage: 'key' }
  }

  let good = false
  try {
    good = verify(null, canonicalBytes, pub, Buffer.from(sigHex, 'hex'))
  } catch {
    good = false
  }
  if (!good) return { ok: false, stage: 'signature' }

  return { ok: true }
}
