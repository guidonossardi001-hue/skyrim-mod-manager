// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END real-download harness (single mod).
//
// Proves the production pipeline against the REAL Nexus Premium API on ONE
// medium-sized mod chosen from data/vortex-collections-backup.json:
//   1. resolve the CDN link via download_link.json (Premium)   → mirrors electron/nexus/downloadLink.ts
//   2. stream-download the .7z/.zip/.rar to data/e2e/           → mirrors electron/install/downloadStream.ts
//   3. validate integrity: md5(download) === md5 in the backup  (pre-extraction, fail-closed)
//   4. extract with the bundled full 7-Zip into the isolated StockGame mods dir
//   5. validate extraction: `7z t` integrity test + non-empty output tree
//
// SECURITY: the API key is read from $NEXUS_API_KEY or secrets/nexus.key (gitignored).
// It is NEVER printed, NEVER written to the repo. Run with no key for a dry-run that
// only does target selection (steps 0–1 preview) and then halts with instructions.
//
// Usage:
//   node scripts/e2e_download.mjs                 # auto-pick smallest mod in 50–200 MB
//   node scripts/e2e_download.mjs <modId> <fileId>  # explicit target
// ─────────────────────────────────────────────────────────────────────────────
import {
  readFileSync,
  existsSync,
  mkdirSync,
  createWriteStream,
  createReadStream,
  statSync,
  rmSync,
  readdirSync,
} from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

// a tiny pass-through that reports byte counts (avoids extra deps)
class TransformStreamCounter extends Transform {
  constructor(onChunk) {
    super()
    this.onChunk = onChunk
  }
  _transform(chunk, _enc, cb) {
    this.onChunk(chunk.length)
    this.push(chunk)
    cb()
  }
}

const ROOT = 'C:/ai/skyrim-mod-manager'
const BACKUP = join(ROOT, 'data', 'vortex-collections-backup.json')
const OUT_DIR = join(ROOT, 'data', 'e2e')
const STOCKGAME_MODS = join(ROOT, 'data', 'StockGame', 'mods') // isolated target (test stand-in)
const SEVENZIP = join(ROOT, 'resources', '7zip-full', '7z.exe') // full build: .7z/.zip/.rar
const GAME = 'skyrimspecialedition'
const MB = 1024 * 1024

const log = (...a) => console.log(...a)
const fail = (msg) => {
  console.error('\n✗ E2E FALLITO:', msg)
  process.exit(1)
}

// ── key (never logged) ───────────────────────────────────────────────────────
function readApiKey() {
  if (process.env.NEXUS_API_KEY && process.env.NEXUS_API_KEY.trim()) return process.env.NEXUS_API_KEY.trim()
  const f = join(ROOT, 'secrets', 'nexus.key')
  if (existsSync(f)) {
    const k = readFileSync(f, 'utf8').trim()
    if (k) return k
  }
  return null
}

// ── target selection from the backup ─────────────────────────────────────────
function pickTarget() {
  if (!existsSync(BACKUP)) fail(`backup non trovato: ${BACKUP}`)
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'))
  const argMod = Number(process.argv[2]),
    argFile = Number(process.argv[3])
  if (Number.isInteger(argMod) && Number.isInteger(argFile)) {
    const hit = b.deduped.find((m) => m.modId === argMod && m.fileId === argFile)
    if (!hit) fail(`mod ${argMod}/${argFile} non presente nel backup`)
    return hit
  }
  // auto: smallest file in [50,200] MB that has a fileId + md5 → fast, verifiable, deterministic
  const range = b.deduped
    .filter((m) => m.fileId && m.md5 && m.fileSize >= 50 * MB && m.fileSize <= 200 * MB)
    .sort((a, b) => a.fileSize - b.fileSize)
  if (!range.length) fail('nessuna mod nel range 50–200 MB con fileId+md5')
  return range[0]
}

// ── Nexus download_link (Premium) ────────────────────────────────────────────
async function resolveCdnLink(modId, fileId, apiKey) {
  const url = `https://api.nexusmods.com/v1/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`
  const res = await fetch(url, {
    headers: { apikey: apiKey, Accept: 'application/json', 'User-Agent': 'SkyrimAEModManager/1.0 (E2E)' },
  })
  if (res.status === 403 || res.status === 401)
    fail("403/401: la chiave non è valida o l'account NON è Premium (download diretto riservato ai Premium)")
  if (res.status === 404) fail('404: mod/file non trovato (id errato o file rimosso da Nexus)')
  if (res.status === 429) fail('429: limite richieste Nexus superato, riprova più tardi')
  if (!res.ok) fail(`download_link HTTP ${res.status}`)
  const data = await res.json()
  const hit = Array.isArray(data) ? data.find((l) => l && typeof l.URI === 'string') : null
  if (!hit) fail('risposta Nexus priva di URI valido')
  return hit.URI
}

function filenameFromUri(uri, fallback) {
  try {
    const p = decodeURIComponent(new URL(uri).pathname)
    const n = p.split('/').pop()
    return n || fallback
  } catch {
    return fallback
  }
}

// ── streaming download with progress ─────────────────────────────────────────
async function download(uri, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const res = await fetch(uri, { headers: { 'User-Agent': 'SkyrimAEModManager/1.0 (E2E)' } })
  if (!res.ok || !res.body) fail(`download HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let done = 0,
    lastPct = -1
  const counter = new TransformStreamCounter((n) => {
    done += n
    if (total) {
      const pct = Math.floor((done / total) * 100)
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct
        log(`   …${pct}% (${(done / MB).toFixed(1)}/${(total / MB).toFixed(1)} MB)`)
      }
    }
  })
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest))
  return statSync(dest).size
}

function md5File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('md5')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

// ── extraction + integrity via full 7-Zip ────────────────────────────────────
function sevenZipTest(archive) {
  const r = spawnSync(SEVENZIP, ['t', archive, '-y'], { encoding: 'utf8' })
  return {
    ok: r.status === 0 && /Everything is Ok/i.test(r.stdout || ''),
    out: (r.stdout || '') + (r.stderr || ''),
  }
}
function sevenZipExtract(archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  const r = spawnSync(SEVENZIP, ['x', archive, '-y', `-o${destDir}`], { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}
function countFilesRec(dir) {
  let n = 0,
    bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const s = countFilesRec(p)
      n += s.n
      bytes += s.bytes
    } else {
      n++
      bytes += statSync(p).size
    }
  }
  return { n, bytes }
}

// ── main ─────────────────────────────────────────────────────────────────────
;(async () => {
  log('═══ E2E download reale (singola mod) ═══\n')
  if (!existsSync(SEVENZIP)) fail(`7-Zip non trovato: ${SEVENZIP}`)

  const t = pickTarget()
  log('TARGET selezionato dal backup:')
  log(`   nome   : ${t.name}`)
  log(`   modId  : ${t.modId}  fileId: ${t.fileId}`)
  log(`   peso   : ${(t.fileSize / MB).toFixed(1)} MB   md5 atteso: ${t.md5}`)
  log(`   collez.: ${t.collection}\n`)

  const apiKey = readApiKey()
  if (!apiKey) {
    log('⏸  NESSUNA CHIAVE TROVATA — dry-run completato (selezione target OK).')
    log('   Per il download reale, inserisci la chiave Premium in UNO di questi modi:')
    log('     • crea il file  secrets\\nexus.key  con dentro SOLO la chiave (una riga), oppure')
    log('     • PowerShell:    $env:NEXUS_API_KEY = "la-tua-chiave"   (vale per la sessione)')
    log('   Poi rilancia:   node scripts/e2e_download.mjs')
    process.exit(2)
  }

  log('① Risoluzione link CDN via API Premium…')
  const uri = await resolveCdnLink(t.modId, t.fileId, apiKey)
  const fname = filenameFromUri(uri, `mod_${t.modId}_${t.fileId}.archive`)
  log(`   ✓ link ottenuto (host: ${new URL(uri).host}) → file: ${fname}\n`)

  const archive = join(OUT_DIR, fname)
  log('② Download reale del pacchetto…')
  const size = await download(uri, archive)
  log(`   ✓ scaricati ${(size / MB).toFixed(1)} MB → ${archive}\n`)

  log('③ Validazione integrità (md5 download vs backup)…')
  const got = await md5File(archive)
  if (got.toLowerCase() !== String(t.md5).toLowerCase())
    fail(
      `md5 NON combacia!\n   atteso: ${t.md5}\n   ottenuto: ${got}\n   → file corrotto o fileId rimappato. Pipeline interrotta (fail-closed).`,
    )
  log(`   ✓ md5 combacia (${got}) — pacchetto integro\n`)

  log('④ Test integrità archivio (7z t)…')
  const test = sevenZipTest(archive)
  if (!test.ok) fail(`l'archivio non supera il test 7-Zip:\n${test.out.split('\n').slice(-8).join('\n')}`)
  log('   ✓ "Everything is Ok"\n')

  const destDir = join(STOCKGAME_MODS, `${t.modId}-${fname.replace(/\.[^.]+$/, '')}`)
  rmSync(destDir, { recursive: true, force: true })
  log('⑤ Estrazione nella cartella isolata StockGame/mods…')
  const ex = sevenZipExtract(archive, destDir)
  if (!ex.ok) fail(`estrazione fallita:\n${ex.out.split('\n').slice(-8).join('\n')}`)
  const tree = countFilesRec(destDir)
  if (tree.n === 0) fail('estrazione prodotta vuota (0 file)')
  log(`   ✓ estratti ${tree.n} file (${(tree.bytes / MB).toFixed(1)} MB) → ${destDir}\n`)

  log('═══ ✅ E2E SUPERATO ═══')
  log(`   ${t.name}: link→download→md5✓→7z-test✓→estrazione✓ (${tree.n} file)`)
})().catch((e) => fail(e?.stack || String(e)))
