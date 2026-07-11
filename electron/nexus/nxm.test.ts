import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { parseNxmUrl, findNxmUrl, createNxmDownload, validateNxmLink } from './nxm'

describe('nxm:// URL parsing', () => {
  it('parses a premium link (mod/file id only)', () => {
    expect(parseNxmUrl('nxm://skyrimspecialedition/mods/2347/files/12345')).toEqual({
      game: 'skyrimspecialedition',
      modId: 2347,
      fileId: 12345,
      key: undefined,
      expires: undefined,
      userId: undefined,
    })
  })

  it('parses a non-premium link with key/expires/user_id', () => {
    const r = parseNxmUrl(
      'nxm://skyrimspecialedition/mods/2347/files/12345?key=abc123&expires=1719200000&user_id=42',
    )
    expect(r).toMatchObject({ modId: 2347, fileId: 12345, key: 'abc123', expires: 1719200000, userId: 42 })
  })

  it('lowercases the game domain and ignores a fragment', () => {
    expect(parseNxmUrl('nxm://SkyrimSpecialEdition/mods/1/files/2#frag')?.game).toBe('skyrimspecialedition')
  })

  it('rejects malformed / non-nxm URLs', () => {
    expect(parseNxmUrl('https://nexusmods.com/mods/1')).toBeNull()
    expect(parseNxmUrl('nxm://game/mods/abc/files/1')).toBeNull() // non-numeric id
    expect(parseNxmUrl('nxm://game/mods/1')).toBeNull() // missing /files/
    expect(parseNxmUrl('')).toBeNull()
  })
})

describe('validateNxmLink (consent-gate first defense)', () => {
  const NOW = 1_719_200_000_000 // ms
  const base = { game: 'skyrimspecialedition', modId: 2347, fileId: 12345 }

  it('accepts a well-formed Skyrim SE link with no expiry (premium)', () => {
    expect(validateNxmLink(base, { now: NOW })).toEqual({ ok: true })
  })

  it('accepts a link whose expiry is still in the future', () => {
    expect(validateNxmLink({ ...base, expires: NOW / 1000 + 3600 }, { now: NOW })).toEqual({ ok: true })
  })

  it('rejects a game outside the whitelist', () => {
    const r = validateNxmLink({ ...base, game: 'fallout4' }, { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('gioco')
  })

  it('rejects a non-positive modId/fileId', () => {
    expect(validateNxmLink({ ...base, modId: 0 }, { now: NOW }).ok).toBe(false)
    expect(validateNxmLink({ ...base, fileId: -1 }, { now: NOW }).ok).toBe(false)
  })

  it('rejects a link whose expiry is already past (anti-replay)', () => {
    const r = validateNxmLink({ ...base, expires: NOW / 1000 - 1 }, { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('scaduto')
  })
})

describe('findNxmUrl (argv interception)', () => {
  it('finds the nxm arg among process argv', () => {
    expect(findNxmUrl(['C:/app.exe', '--flag', 'nxm://skyrimspecialedition/mods/1/files/2'])).toBe(
      'nxm://skyrimspecialedition/mods/1/files/2',
    )
  })
  it('returns null when no nxm arg is present', () => {
    expect(findNxmUrl(['C:/app.exe', '--flag'])).toBeNull()
  })
})

describe('createNxmDownload (enqueue row)', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = openTestDb()
    applyPragmas(db)
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER, name TEXT NOT NULL);
      CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL,
        nexus_id INTEGER, file_id INTEGER, name TEXT NOT NULL, url TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    `)
    runMigrations(db) // v5 adds nxm_key / nxm_expires to downloads
    db.prepare('INSERT INTO profiles (id,name) VALUES (1,?)').run('P1')
  })

  it('links to an existing mod and persists key/expires', () => {
    db.prepare('INSERT INTO mods (id,profile_id,nexus_id,name) VALUES (10,1,2347,?)').run('SkyUI')
    const id = createNxmDownload(
      db,
      { game: 'skyrimspecialedition', modId: 2347, fileId: 12345, key: 'k', expires: 1719 },
      { profileId: 1 },
    )
    const row = db.prepare('SELECT * FROM downloads WHERE id=?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({
      mod_id: 10,
      nexus_id: 2347,
      file_id: 12345,
      name: 'SkyUI',
      status: 'pending',
      nxm_key: 'k',
      nxm_expires: 1719,
    })
  })

  it('falls back to a generated name when the mod is not installed', () => {
    const id = createNxmDownload(
      db,
      { game: 'skyrimspecialedition', modId: 999, fileId: 5 },
      { profileId: 1 },
    )
    const row = db.prepare('SELECT mod_id, name, nxm_key FROM downloads WHERE id=?').get(id) as Record<
      string,
      unknown
    >
    expect(row.mod_id).toBeNull()
    expect(row.name).toMatch(/Nexus mod 999/)
    expect(row.nxm_key).toBeNull()
  })
})
