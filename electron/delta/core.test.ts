import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createHash, sign as edSign } from 'crypto'
import { canonicalJSON } from './canonicalJson'
import { compareVersions, isNewer } from './version'
import { verifyManifest, DEFAULT_ALLOWED_HOSTS, type ManifestBody, type SignedManifest } from './manifest'
import { computeChangeset, summarizeChangeset, type SnapshotRow, type ReleaseRow } from './diff'

// ── canonicalJSON ────────────────────────────────────────────────────────────
describe('canonicalJSON', () => {
  it('is key-order independent and whitespace-free', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJSON({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })
  it('sorts nested objects deeply', () => {
    expect(canonicalJSON({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    )
  })
})

// ── compareVersions (tolerant, never throws) ─────────────────────────────────
describe('compareVersions', () => {
  it('treats 1.0 and 1.0.0 as equal', () => expect(compareVersions('1.0', '1.0.0')).toBe(0))
  it('orders numerically', () => {
    expect(compareVersions('1.2', '1.10')).toBe(-1)
    expect(compareVersions('2.0', '1.9')).toBe(1)
  })
  it('strips leading v', () => expect(compareVersions('v1.5', '1.5')).toBe(0))
  it('release > prerelease', () => expect(compareVersions('1.2', '1.2-beta')).toBe(1))
  it('never throws on junk / null / undefined', () => {
    expect(() => compareVersions(null, undefined)).not.toThrow()
    expect(() => compareVersions('SE 1.5a', '')).not.toThrow()
    expect(compareVersions('', '')).toBe(0)
  })
  it('isNewer is consistent', () => {
    expect(isNewer('2.0', '1.0')).toBe(true)
    expect(isNewer('1.0', '1.0')).toBe(false)
  })
})

// ── verifyManifest (the security boundary) ───────────────────────────────────
function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  }
}
function signManifest(
  body: ManifestBody,
  privateKey: ReturnType<typeof makeKeys>['privateKey'],
): SignedManifest {
  const payload = Buffer.from(canonicalJSON(body), 'utf8')
  return {
    manifest: body,
    sha256: createHash('sha256').update(payload).digest('hex'),
    sig_ed25519: edSign(null, payload, privateKey).toString('hex'),
  }
}
const baseManifest: ManifestBody = {
  release_tag: '2026.06.22',
  release_counter: 5,
  published_at: '2026-06-22T00:00:00Z',
  mods: [
    {
      nexus_id: 1137,
      name: 'SkyUI',
      version: '5.2',
      file_id: 9,
      file_name: 'SkyUI.7z',
      file_hash: 'abc',
      download_url: 'https://files.nexusmods.com/9.7z',
    },
  ],
}

describe('verifyManifest', () => {
  it('accepts a correctly signed, fresh manifest', () => {
    const { publicKeyPem, privateKey } = makeKeys()
    const signed = signManifest(baseManifest, privateKey)
    const r = verifyManifest(signed, { publicKeyPem, lastCounter: 4, allowedHosts: DEFAULT_ALLOWED_HOSTS })
    expect(r.ok).toBe(true)
    expect(r.manifest?.release_tag).toBe('2026.06.22')
  })
  it('rejects a tampered manifest body (signature no longer matches)', () => {
    const { publicKeyPem, privateKey } = makeKeys()
    const signed = signManifest(baseManifest, privateKey)
    signed.manifest.mods[0].download_url = 'https://files.nexusmods.com/evil.7z' // tamper after signing
    const r = verifyManifest(signed, { publicKeyPem, lastCounter: 4, allowedHosts: DEFAULT_ALLOWED_HOSTS })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/hash|firma/i)
  })
  it('rejects a manifest signed by a different (untrusted) key', () => {
    const trusted = makeKeys()
    const attacker = makeKeys()
    const signed = signManifest(baseManifest, attacker.privateKey)
    const r = verifyManifest(signed, {
      publicKeyPem: trusted.publicKeyPem,
      lastCounter: 4,
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/firma/i)
  })
  it('rejects replay / downgrade (counter not monotonic)', () => {
    const { publicKeyPem, privateKey } = makeKeys()
    const signed = signManifest(baseManifest, privateKey) // counter 5
    const r = verifyManifest(signed, { publicKeyPem, lastCounter: 5, allowedHosts: DEFAULT_ALLOWED_HOSTS })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/replay|downgrade/i)
    expect(r.freshness).toBe(true)
  })
  it('rejects a newer counter carrying an OLDER published_at (freshness axis 2)', () => {
    const { publicKeyPem, privateKey } = makeKeys()
    const stale: ManifestBody = { ...baseManifest, release_counter: 6, published_at: '2026-06-20T00:00:00Z' }
    const signed = signManifest(stale, privateKey)
    const r = verifyManifest(signed, {
      publicKeyPem,
      lastCounter: 5,
      lastPublishedAt: '2026-06-22T00:00:00Z',
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
    })
    expect(r.ok).toBe(false)
    expect(r.freshness).toBe(true)
    expect(r.error).toMatch(/published_at/)
  })
  it('rejects a download_url on a non-allowlisted host', () => {
    const { publicKeyPem, privateKey } = makeKeys()
    const evil: ManifestBody = {
      ...baseManifest,
      release_counter: 6,
      mods: [{ ...baseManifest.mods[0], download_url: 'https://evil.example.com/x.7z' }],
    }
    const signed = signManifest(evil, privateKey)
    const r = verifyManifest(signed, { publicKeyPem, lastCounter: 4, allowedHosts: DEFAULT_ALLOWED_HOSTS })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/host/i)
  })
  it('never throws on malformed input', () => {
    const { publicKeyPem } = makeKeys()
    expect(() =>
      verifyManifest({} as SignedManifest, { publicKeyPem, lastCounter: 0, allowedHosts: [] }),
    ).not.toThrow()
  })
})

// ── computeChangeset ─────────────────────────────────────────────────────────
const snap = (over: Partial<SnapshotRow>): SnapshotRow => ({
  nexus_id: 1,
  version: '1.0',
  file_id: 1,
  file_hash: 'h1',
  load_order: 1,
  ...over,
})
const rel = (over: Partial<ReleaseRow>): ReleaseRow => ({
  nexus_id: 1,
  name: 'M',
  version: '1.0',
  file_id: 1,
  file_name: 'M.7z',
  file_hash: 'h1',
  download_url: null,
  priority_order: 1,
  ...over,
})

describe('computeChangeset', () => {
  it('detects added / removed / changed / reordered', () => {
    const snapshot = [
      snap({ nexus_id: 1 }),
      snap({ nexus_id: 2, file_hash: 'old' }),
      snap({ nexus_id: 3, load_order: 1 }),
    ]
    const release = [
      rel({ nexus_id: 1 }), // unchanged
      rel({ nexus_id: 2, file_hash: 'new' }), // changed (hash)
      rel({ nexus_id: 3, priority_order: 9 }), // reordered
      rel({ nexus_id: 4, name: 'New' }), // added
    ]
    const cs = computeChangeset(snapshot, release)
    const byType = Object.fromEntries(cs.map((c) => [c.nexus_id, c.change_type]))
    expect(byType).toEqual({ 2: 'changed', 3: 'reordered', 4: 'added' })
    expect(cs.find((c) => c.nexus_id === 2)?.to_file_hash).toBe('new')
  })
  it('flags removed when a mod disappears from the release', () => {
    const cs = computeChangeset([snap({ nexus_id: 7 })], [])
    expect(cs).toHaveLength(1)
    expect(cs[0]).toMatchObject({ nexus_id: 7, change_type: 'removed' })
  })
  it('falls back to tolerant version compare when a hash is missing', () => {
    const cs = computeChangeset(
      [snap({ file_hash: null, version: '1.0' })],
      [rel({ file_hash: null, version: '1.1' })],
    )
    expect(cs[0].change_type).toBe('changed')
  })
  it('summarizes counts', () => {
    const cs = computeChangeset([snap({ nexus_id: 9 })], [rel({ nexus_id: 10, name: 'A' })])
    expect(summarizeChangeset(cs)).toMatchObject({ added: 1, removed: 1, changed: 0, reordered: 0 })
  })
})
