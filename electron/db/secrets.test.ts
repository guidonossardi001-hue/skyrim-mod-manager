import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from './sqlite'
import { openTestDb } from './openTestDb'
import { runMigrations } from './migrations'
import { setSecret, getSecret, hasSecret, type SecretCrypto } from './secrets'

// Reversible stand-in for safeStorage: proves the table only ever holds ciphertext.
const crypto: SecretCrypto = {
  encrypt: (p) => 'enc:' + Buffer.from(p, 'utf8').toString('base64'),
  decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s),
}

function setup(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER, name TEXT NOT NULL);
  `)
  runMigrations(db) // includes v4 → app_secrets
  return db
}

describe('app_secrets store (encrypted Nexus API key persistence)', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = setup()
  })

  it('migration v4 creates the app_secrets table', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_secrets'").get()
    expect(t).toBeTruthy()
  })

  it('round-trips a secret and reports presence', () => {
    setSecret(db, 'nexusApiKey', 'my-secret-key', crypto)
    expect(hasSecret(db, 'nexusApiKey')).toBe(true)
    expect(getSecret(db, 'nexusApiKey', crypto)).toBe('my-secret-key')
  })

  it('persists CIPHERTEXT, never the plaintext key', () => {
    setSecret(db, 'nexusApiKey', 'plaintext-123', crypto)
    const raw = (
      db.prepare('SELECT value FROM app_secrets WHERE name=?').get('nexusApiKey') as { value: string }
    ).value
    expect(raw).not.toContain('plaintext-123')
    expect(raw.startsWith('enc:')).toBe(true)
  })

  it('overwrites an existing secret', () => {
    setSecret(db, 'nexusApiKey', 'old', crypto)
    setSecret(db, 'nexusApiKey', 'new', crypto)
    expect(getSecret(db, 'nexusApiKey', crypto)).toBe('new')
    expect((db.prepare('SELECT COUNT(*) c FROM app_secrets').get() as { c: number }).c).toBe(1)
  })

  it('an empty value removes the secret', () => {
    setSecret(db, 'nexusApiKey', 'something', crypto)
    setSecret(db, 'nexusApiKey', '', crypto)
    expect(hasSecret(db, 'nexusApiKey')).toBe(false)
    expect(getSecret(db, 'nexusApiKey', crypto)).toBeNull()
  })

  it('returns null for an unknown secret', () => {
    expect(getSecret(db, 'missing', crypto)).toBeNull()
  })

  // Requirement #3 — graceful reset when a stored ciphertext can no longer be decrypted
  // (DB moved to another PC/user: OS-bound DPAPI/Keychain key is gone). The row is present
  // but undecryptable; the app must surface "no key", never crash, and let the user re-enter.
  describe('decrypt failure (moved-to-another-PC) is handled gracefully', () => {
    // safeStorage.decryptString surfaces failure two ways depending on the value; the
    // main-process adapter catches and returns '', but the store must be robust to either.
    const failReturnsEmpty: SecretCrypto = { encrypt: crypto.encrypt, decrypt: () => '' }
    const failThrows: SecretCrypto = {
      encrypt: crypto.encrypt,
      decrypt: () => {
        throw new Error('DPAPI: cannot decrypt on this machine')
      },
    }

    it('surfaces null (not the ciphertext, not a throw) when decrypt yields empty', () => {
      setSecret(db, 'nexusApiKey', 'real-key-from-pc-A', crypto)
      expect(() => getSecret(db, 'nexusApiKey', failReturnsEmpty)).not.toThrow()
      expect(getSecret(db, 'nexusApiKey', failReturnsEmpty)).toBeNull()
    })

    it('surfaces null (does not propagate) when decrypt throws', () => {
      setSecret(db, 'nexusApiKey', 'real-key-from-pc-A', crypto)
      expect(() => getSecret(db, 'nexusApiKey', failThrows)).not.toThrow()
      expect(getSecret(db, 'nexusApiKey', failThrows)).toBeNull()
    })

    it('re-entering a key UPSERTs over the undecryptable row (reset-on-re-entry)', () => {
      setSecret(db, 'nexusApiKey', 'stale-key-from-pc-A', crypto)
      // On PC B the old row is undecryptable → reads as null → user re-enters a fresh key.
      expect(getSecret(db, 'nexusApiKey', failThrows)).toBeNull()
      setSecret(db, 'nexusApiKey', 'fresh-key-on-pc-B', crypto)
      expect(getSecret(db, 'nexusApiKey', crypto)).toBe('fresh-key-on-pc-B')
      // No orphaned duplicate: the reset overwrote in place.
      expect((db.prepare('SELECT COUNT(*) c FROM app_secrets').get() as { c: number }).c).toBe(1)
    })
  })
})
