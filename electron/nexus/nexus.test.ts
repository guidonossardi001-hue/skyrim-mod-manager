import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { NexusCache } from './cache'
import { MockNexusProvider } from './mockProvider'
import { createNexusProvider } from './index'

function db(): SqliteDb {
  const d = openTestDb()
  applyPragmas(d)
  d.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY); CREATE TABLE mods (id INTEGER PRIMARY KEY, profile_id INTEGER, nexus_id INTEGER, name TEXT NOT NULL);
    CREATE TABLE modlist_catalog (id INTEGER PRIMARY KEY, nexus_id INTEGER, name TEXT NOT NULL, category TEXT NOT NULL);
  `)
  runMigrations(d) // creates nexus_cache + catalog nexus_* columns (migration 3)
  return d
}

describe('NexusCache (TTL + ETag)', () => {
  let d: SqliteDb
  beforeEach(() => {
    d = db()
  })

  it('serves a fresh entry and stores the ETag', () => {
    const c = new NexusCache(d)
    c.set('/mods/1.json', '{"v":1}', 'W/"abc"', 60_000)
    const hit = c.get('/mods/1.json')
    expect(hit).not.toBeNull()
    expect(hit!.body).toBe('{"v":1}')
    expect(hit!.etag).toBe('W/"abc"')
  })

  it('misses on a fresh GET when expired, but getStale still returns it (offline)', () => {
    const c = new NexusCache(d)
    c.set('/mods/2.json', '{"v":2}', null, 60_000)
    d.prepare('UPDATE nexus_cache SET fetched_at = fetched_at - 120000 WHERE key=?').run('/mods/2.json') // age it past TTL
    expect(c.get('/mods/2.json')).toBeNull()
    const stale = c.getStale('/mods/2.json')
    expect(stale).not.toBeNull()
    expect(stale!.fresh).toBe(false)
    expect(stale!.body).toBe('{"v":2}')
  })

  it('upserts on the same key', () => {
    const c = new NexusCache(d)
    c.set('/x', 'a', null, 1000)
    c.set('/x', 'b', null, 1000)
    expect(c.get('/x')!.body).toBe('b')
    expect((d.prepare('SELECT COUNT(*) n FROM nexus_cache').get() as { n: number }).n).toBe(1)
  })
})

describe('MockNexusProvider', () => {
  const p = new MockNexusProvider()
  it('returns canned metadata', async () => {
    expect((await p.getMod(17230))?.name).toMatch(/SKSE64/)
    expect(await p.getMod(999999)).toBeNull()
  })
  it('searches by name', async () => {
    const r = await p.searchByName('sky')
    expect(r.some((m) => m.name === 'SkyUI')).toBe(true)
  })
  it('checks updates with the tolerant comparator', async () => {
    expect((await p.checkUpdate(1137, '5.2SE')).hasUpdate).toBe(true) // mock latest 5.3SE
    expect((await p.checkUpdate(1137, '5.3SE')).hasUpdate).toBe(false)
  })
})

describe('createNexusProvider (deferred activation)', () => {
  it('returns the MOCK provider when disabled or keyless', () => {
    expect(createNexusProvider(db(), { enabled: false }).kind).toBe('mock')
    expect(createNexusProvider(db(), { enabled: true, apiKey: '' }).kind).toBe('mock')
  })
  it('activates the HTTP provider when enabled + key present', () => {
    const p = createNexusProvider(db(), { enabled: true, apiKey: 'a-real-looking-key-1234' })
    expect(p.kind).toBe('http')
    expect(p.enabled).toBe(true)
  })
})
