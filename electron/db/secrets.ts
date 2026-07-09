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

/** Read and decrypt a named secret, or null if absent/empty/undecryptable. */
export function getSecret(db: SqliteDb, name: string, crypto: SecretCrypto): string | null {
  const row = db.prepare('SELECT value FROM app_secrets WHERE name=?').get(name) as
    { value: string } | undefined
  if (!row) return null
  const plain = crypto.decrypt(row.value)
  return plain || null
}

export function hasSecret(db: SqliteDb, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM app_secrets WHERE name=?').get(name)
}
