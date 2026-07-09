// One-shot, READ-ONLY export of the real Vortex collection.json files into a single
// versioned, integrity-stamped backup. Does NOT touch Steam, the game, or Vortex —
// it only reads collection.json and writes ONE backup file. Mirrors the parsing/dedup
// logic in electron/vortex/scan.ts so the backup is faithful to what the app would import.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'

const MODS_ROOT = 'C:/Users/User/AppData/Roaming/Vortex/skyrimse/mods'
const OUT = 'C:/ai/skyrim-mod-manager/data/vortex-collections-backup.json'
const SCHEMA_VERSION = 1

// ── parsing (faithful to scan.ts) ────────────────────────────────────────────
function parseCollection(json, collectionName, dir) {
  const mods = json?.mods
  if (!Array.isArray(mods)) return []
  const out = []
  for (const m of mods) {
    const s = m.source
    if (!s || s.type !== 'nexus' || typeof s.modId !== 'number') continue
    out.push({
      modId: s.modId,
      fileId: typeof s.fileId === 'number' ? s.fileId : null,
      name: s.logicalFilename ?? m.name ?? `Mod ${s.modId}`,
      fileSize: typeof s.fileSize === 'number' ? s.fileSize : undefined,
      md5: s.md5 ?? undefined,
      optional: !!m.optional,
      phase: m.phase,
      collection: collectionName,
      collectionDir: dir,
    })
  }
  return out
}

function dedupeMods(mods) {
  const best = new Map()
  let removed = 0
  const score = (m) => 4 + (m.optional ? 0 : 2) + (m.fileId != null ? 1 : 0) // all here are 'collection' source
  for (const m of mods) {
    const cur = best.get(m.modId)
    if (!cur) {
      best.set(m.modId, m)
      continue
    }
    removed++
    const better = score(m) > score(cur) || (score(m) === score(cur) && (m.fileId ?? 0) > (cur.fileId ?? 0))
    if (better) best.set(m.modId, m)
  }
  return { mods: [...best.values()].sort((a, b) => a.modId - b.modId), removed }
}

// ── scan ─────────────────────────────────────────────────────────────────────
if (!existsSync(MODS_ROOT)) {
  console.error('MODS_ROOT non trovato:', MODS_ROOT)
  process.exit(1)
}

const dirs = readdirSync(MODS_ROOT).filter((d) => {
  try {
    return statSync(join(MODS_ROOT, d)).isDirectory() && existsSync(join(MODS_ROOT, d, 'collection.json'))
  } catch {
    return false
  }
})

const collections = []
const allMods = []
for (const dir of dirs) {
  const p = join(MODS_ROOT, dir, 'collection.json')
  const raw = readFileSync(p, 'utf8')
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    console.error('JSON malformato, salto:', dir, e.message)
    continue
  }
  const name = json?.info?.name ?? dir
  const parsed = parseCollection(json, name, dir)
  collections.push({
    name,
    dir,
    sourcePath: p,
    rawByteSize: Buffer.byteLength(raw, 'utf8'),
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    totalModEntries: Array.isArray(json?.mods) ? json.mods.length : 0,
    nexusModEntries: parsed.length,
    mods: parsed,
  })
  allMods.push(...parsed)
}

const { mods: deduped, removed } = dedupeMods(allMods)
const totalBytes = deduped.reduce((a, m) => a + (m.fileSize ?? 0), 0)
const withFileId = deduped.filter((m) => m.fileId != null).length

// integrity hash over the canonical deduped payload (sorted by modId already)
const payloadForHash = JSON.stringify(
  deduped.map((m) => ({ modId: m.modId, fileId: m.fileId, md5: m.md5 ?? null })),
)
const integritySha256 = createHash('sha256').update(payloadForHash).digest('hex')

const backup = {
  schemaVersion: SCHEMA_VERSION,
  kind: 'vortex-collections-backup',
  generatedAt: new Date().toISOString(),
  generator: 'scripts/_export_collections_backup.mjs',
  sourceRoot: MODS_ROOT,
  note: 'READ-ONLY snapshot of Vortex collection.json files. Source of truth for modId/fileId/md5/fileSize before any cleanup. Keep this file safe.',
  stats: {
    collectionsFound: collections.length,
    totalNexusEntries: allMods.length,
    uniqueMods: deduped.length,
    duplicatesRemoved: removed,
    modsWithFileId: withFileId,
    modsWithoutFileId: deduped.length - withFileId,
    totalArchiveBytes: totalBytes,
    totalArchiveGB: +(totalBytes / 1024 ** 3).toFixed(2),
  },
  integritySha256,
  collections, // full raw-per-collection (nothing lost; duplicates preserved here)
  deduped, // unified de-duplicated install list (modId, fileId, md5, fileSize, name, ...)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(backup, null, 2), 'utf8')

const outBytes = statSync(OUT).size
console.log('OK backup scritto:', OUT)
console.log('  byte file:', outBytes.toLocaleString())
console.log(
  '  collezioni:',
  collections.length,
  '→',
  collections.map((c) => `${c.name} (${c.nexusModEntries})`).join(', '),
)
console.log('  entries Nexus totali:', allMods.length)
console.log('  mod uniche (dedup):', deduped.length, '| duplicati rimossi:', removed)
console.log('  con fileId:', withFileId, '| senza fileId:', deduped.length - withFileId)
console.log('  byte archivi noti:', totalBytes.toLocaleString(), '=', backup.stats.totalArchiveGB, 'GB')
console.log('  integritySha256:', integritySha256)
