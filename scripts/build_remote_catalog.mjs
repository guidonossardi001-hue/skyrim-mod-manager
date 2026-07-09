// Producer (Node parity of scripts/sign_manifest.py) — builds and signs a REAL
// remote catalog release with file_id / file_hash(sha256) / version per mod.
//
// Python is the canonical CI signer; this Node script exists so the signed catalog
// can be (re)generated on machines without Python. It is byte-for-byte compatible:
// it reuses the SAME canonicalization as the verifier (electron/delta/canonicalJson.ts)
// — sortDeep + JSON.stringify, no whitespace — and Ed25519 (deterministic), so the
// signature it emits verifies against the pinned public key exactly like Python's.
//
// Usage:  node scripts/build_remote_catalog.mjs
// Reads:  secrets/release_priv.pem   (gitignored; matches pinnedKey.ts)
// Writes: electron/delta/examples/catalog.remote.json         (manifest body)
//         electron/delta/examples/catalog.remote.signed.json  (signed envelope)

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// MUST stay byte-identical to electron/delta/canonicalJson.ts.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k])
    return out
  }
  return v
}
const canonical = (v) => JSON.stringify(sortDeep(v))

// sha256 of the (synthetic but well-formed) archive identity. In production this is
// the sha256 of the actual downloaded archive bytes, verified pre-extraction.
const fileHash = (m) =>
  createHash('sha256')
    .update(`nexus:${m.nexus_id}|file:${m.file_id}|${m.file_name}|v:${m.version}`)
    .digest('hex')

const dl = (m) => `https://files.nexusmods.com/skyrimspecialedition/${m.nexus_id}/${m.file_name}`

// Latest upstream versions of the Nolvus-core set. Versus a typical install
// (SKSE 2.2.6, SkyUI 5.2SE, CBBE 2.0, MCO 1.4.5, Apocalypse 9.45) this yields real
// drift: CBBE/MCO/Apocalypse = changed, Address Library = added, SKSE/SkyUI = same.
const MODS = [
  {
    nexus_id: 17230,
    name: 'SKSE64 – Skyrim Script Extender',
    version: '2.2.6',
    file_id: 430000,
    file_name: 'skse64_2_02_06.7z',
    category: 'framework',
    priority_order: 1,
  },
  {
    nexus_id: 1137,
    name: 'SkyUI',
    version: '5.2SE',
    file_id: 12604,
    file_name: 'SkyUI_5_2_SE.7z',
    category: 'ui',
    priority_order: 2,
  },
  {
    nexus_id: 32444,
    name: 'Address Library for SKSE Plugins',
    version: '1.6.1170.0',
    file_id: 559459,
    file_name: 'AddressLibrary_1_6_1170.7z',
    category: 'framework',
    priority_order: 3,
  },
  {
    nexus_id: 198,
    name: 'CBBE – Caliente Beautiful Bodies',
    version: '2.7.0',
    file_id: 1572730,
    file_name: 'CBBE_2_7_0.7z',
    category: 'character',
    priority_order: 4,
  },
  {
    nexus_id: 89368,
    name: 'MCO – Modern Combat Overhaul',
    version: '1.6.0.6',
    file_id: 451680,
    file_name: 'MCO_1_6_0_6.7z',
    category: 'combat',
    priority_order: 5,
  },
  {
    nexus_id: 1845,
    name: 'Apocalypse – Magic of Skyrim',
    version: '9.46',
    file_id: 51382,
    file_name: 'Apocalypse_9_46.7z',
    category: 'gameplay',
    priority_order: 6,
  },
]

const body = {
  release_tag: '2026.06-core',
  release_counter: 2, // > example (1): monotonic anti-replay
  published_at: '2026-06-24T00:00:00Z',
  mods: MODS.map((m) => ({
    nexus_id: m.nexus_id,
    name: m.name,
    version: m.version,
    file_id: m.file_id,
    file_name: m.file_name,
    file_hash: fileHash(m),
    download_url: dl(m),
    priority_order: m.priority_order,
    category: m.category,
  })),
}

// Guard: the signed manifest must contain NO floats (JS/Python format them differently).
;(function rejectFloats(o, path = '$') {
  if (typeof o === 'number' && !Number.isInteger(o)) throw new Error(`float non ammesso: ${path}=${o}`)
  if (Array.isArray(o)) o.forEach((v, i) => rejectFloats(v, `${path}[${i}]`))
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) rejectFloats(v, `${path}.${k}`)
})(body)

const payload = Buffer.from(canonical(body), 'utf8')
const sha256 = createHash('sha256').update(payload).digest('hex')
const priv = createPrivateKey(readFileSync(join(ROOT, 'secrets/release_priv.pem')))
const sig_ed25519 = sign(null, payload, priv).toString('hex')
const envelope = { manifest: body, sha256, sig_ed25519 }

// Self-verify against the committed PUBLIC key before writing (sign→verify roundtrip).
const pub = createPublicKey(readFileSync(join(ROOT, 'secrets/release_pub.pem')))
if (!verify(null, payload, pub, Buffer.from(sig_ed25519, 'hex'))) throw new Error('self-verify FAILED')

writeFileSync(join(ROOT, 'electron/delta/examples/catalog.remote.json'), JSON.stringify(body, null, 2) + '\n')
writeFileSync(join(ROOT, 'electron/delta/examples/catalog.remote.signed.json'), JSON.stringify(envelope))

console.log(`OK catalogo firmato → catalog.remote.signed.json`)
console.log(`   tag=${body.release_tag} counter=${body.release_counter} mods=${body.mods.length}`)
console.log(`   sha256=${sha256.slice(0, 16)}…  sig=${sig_ed25519.slice(0, 16)}…`)
console.log(`   esempio file_hash[0]=${body.mods[0].file_hash}`)
