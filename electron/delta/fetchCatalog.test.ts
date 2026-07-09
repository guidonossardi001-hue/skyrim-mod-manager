import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { runMigrations } from '../db/migrations'
import { fetchSignedManifest, isHostAllowed } from './fetchCatalog'
import { verifyManifest, DEFAULT_ALLOWED_HOSTS, type SignedManifest } from './manifest'
import { pinnedPublicKey } from './pinnedKey'
import { DeltaService } from './service'

const signedRaw = readFileSync(
  fileURLToPath(new URL('./examples/catalog.remote.signed.json', import.meta.url)),
  'utf8',
)

const servers: Server[] = []
function startServer(
  respond: (path: string) => { status?: number; body?: string; headers?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const r = respond(req.url ?? '/')
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) })
      res.end(r.body ?? '')
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}
afterEach(() => {
  while (servers.length) servers.pop()!.close()
})

const LOCAL = { allowedHosts: ['127.0.0.1'], allowProtocols: ['http:'] }

function dbWithInstall(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, is_installed INTEGER DEFAULT 0, priority INTEGER DEFAULT 0, load_order INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'pending', downloaded_size INTEGER DEFAULT 0);
  `)
  runMigrations(db)
  db.prepare('INSERT INTO profiles (id,name) VALUES (1,?)').run('P1')
  db.prepare(
    "INSERT INTO mods (id,profile_id,nexus_id,name,version,is_installed,load_order) VALUES (2,1,198,'CBBE','2.0',1,4)",
  ).run()
  return db
}

describe('Act-03: real HTTP fetch of the signed catalog', () => {
  it('host allow-list matches exact host and dotted suffix, rejects look-alikes', () => {
    expect(isHostAllowed('github.com', ['github.com'])).toBe(true)
    expect(isHostAllowed('raw.githubusercontent.com', ['.githubusercontent.com'])).toBe(true)
    expect(isHostAllowed('github.com.evil.com', ['github.com'])).toBe(false)
    expect(isHostAllowed('127.0.0.1', ['127.0.0.1'])).toBe(true)
  })

  it('fetches over a real socket, verifies the signature, and ingests (end-to-end)', async () => {
    const base = await startServer(() => ({ body: signedRaw }))
    const signed = await fetchSignedManifest(`${base}/catalog.remote.signed.json`, LOCAL)

    // The bytes that came off the wire verify against the PINNED key.
    const v = verifyManifest(signed, {
      publicKeyPem: pinnedPublicKey(),
      lastCounter: 0,
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    })
    expect(v.ok).toBe(true)

    const db = dbWithInstall()
    const svc = new DeltaService(db, { publicKeyPem: pinnedPublicKey() })
    const ing = svc.ingest(signed)
    expect(ing.success).toBe(true)
    const drift = svc.checkUpdates(1)
    expect(drift.updates.find((u) => u.nexus_id === 198)).toMatchObject({
      change_type: 'changed',
      to_version: '2.7.0',
    })
  })

  it('rejects a non-allow-listed host before any request', async () => {
    await expect(
      fetchSignedManifest('https://evil.example.com/catalog.json', { allowedHosts: ['github.com'] }),
    ).rejects.toThrow(/host catalogo non consentito/)
  })

  it('rejects a disallowed protocol (http when only https is allowed)', async () => {
    const base = await startServer(() => ({ body: signedRaw }))
    await expect(fetchSignedManifest(`${base}/c.json`, { allowedHosts: ['127.0.0.1'] })) // default: https only
      .rejects.toThrow(/protocollo non consentito/)
  })

  it('rejects an oversized response (size cap)', async () => {
    const base = await startServer(() => ({ body: signedRaw }))
    await expect(fetchSignedManifest(`${base}/c.json`, { ...LOCAL, maxBytes: 50 })).rejects.toThrow(
      /troppo grande/,
    )
  })

  it('rejects a redirect (no bounce to an internal host)', async () => {
    const base = await startServer(() => ({
      status: 302,
      headers: { location: 'http://127.0.0.1:1/internal' },
    }))
    await expect(fetchSignedManifest(`${base}/c.json`, LOCAL)).rejects.toThrow(/fetch catalogo fallito/)
  })

  it('does not bypass the trust boundary: a tampered served body fails verification', async () => {
    const tampered = JSON.parse(signedRaw) as SignedManifest
    tampered.manifest.mods[0].version = tampered.manifest.mods[0].version + '-evil'
    const base = await startServer(() => ({ body: JSON.stringify(tampered) }))

    const signed = await fetchSignedManifest(`${base}/c.json`, LOCAL) // transport accepts well-formed JSON
    const v = verifyManifest(signed, {
      publicKeyPem: pinnedPublicKey(),
      lastCounter: 0,
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    })
    expect(v.ok).toBe(false) // signature catches the tamper
  })
})
