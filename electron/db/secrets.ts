import type { SqliteDb } from './sqlite'

// SQLite-backed secret store. The CALLER provides the crypto (OS keychain / DPAPI via
// Electron safeStorage in production), so this layer only ever persists ciphertext —
// the plaintext key never touches the database file. Pure + injectable → unit-testable.

export interface SecretCrypto {
  encrypt: (plaintext: string) => string
  decrypt: (stored: string) => string
}

/** Store (or, with an empty value, remove) a named secret. Value is encrypted first. */
export function setSecret(db: SqliteDb, name: string, plaintext: string, crypto: SecretCrypto): void {
  if (!plaintext) {
    db.prepare('DELETE FROM app_secrets WHERE name=?').run(name)
    return
  }
  const value = crypto.encrypt(plaintext)
  db.prepare(
    `INSERT INTO app_secrets (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`,
  ).run(name, value)
}

/**
 * Read and decrypt a named secret, or null if absent/empty/undecryptable.
 *
 * The decrypt is wrapped so a ciphertext that cannot be decrypted (e.g. the DB was
 * copied to another machine/user — OS-bound DPAPI/Keychain keys don't travel) surfaces
 * as a clean null instead of throwing. Callers then behave exactly as "no key set":
 * the UI shows an empty field and the user re-enters, which UPSERTs over the stale row.
 * That is the graceful "reset + re-prompt, no crash" path — robust regardless of whether
 * the injected crypto reports failure by returning '' or by throwing.
 */
export function getSecret(db: SqliteDb, name: string, crypto: SecretCrypto): string | null {
  const row = db.prepare('SELECT value FROM app_secrets WHERE name=?').get(name) as
    { value: string } | undefined
  if (!row) return null
  try {
    const plain = crypto.decrypt(row.value)
    return plain || null
  } catch {
    return null
  }
}

export function hasSecret(db: SqliteDb, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM app_secrets WHERE name=?').get(name)
}
