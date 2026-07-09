// ─────────────────────────────────────────────────────────────────────────────
// E2E-BATCH — scale validation of the real download pipeline before wiping Vortex.
//
// Picks a small mixed-format batch from data/vortex-collections-backup.json
// (≥1 .zip, ≥1 .7z, ≥1 .rar if available + 1 multi-GB file), then for each mod:
//   resolve CDN (Premium) → RESUMABLE download (.part + HTTP Range, mirrors
//   electron/install/downloadStream.ts) → md5 vs backup (fail-closed) → 7z integrity
//   test → extract into the isolated StockGame/mods → count files.
// Downloads run CONCURRENTLY (worker pool). One file also runs an interrupt+resume
// SELF-TEST (abort mid-stream, then resume from .part) to prove big files survive a
// dropped connection without corruption.
//
// Real-time logs go to stdout AND data/e2e/batch.log. Key from secrets/nexus.key
// or $NEXUS_API_KEY (never printed, never committed).
//
//   node scripts/e2e_batch.mjs            # discover + run the batch
//   node scripts/e2e_batch.mjs --plan     # discovery only (no downloads)
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
  appendFileSync,
  renameSync,
} from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

const ROOT = 'C:/ai/skyrim-mod-manager'
const BACKUP = join(ROOT, 'data', 'vortex-collections-backup.json')
const OUT_DIR = join(ROOT, 'data', 'e2e')
const STOCKGAME_MODS = join(ROOT, 'data', 'StockGame', 'mods')
const SEVENZIP = join(ROOT, 'resources', '7zip-full', '7z.exe')
const LOGFILE = join(OUT_DIR, 'batch.log')
const GAME = 'skyrimspecialedition'
const MB = 1024 * 1024,
  GB = 1024 * MB
const CONCURRENCY = 3
const PLAN_ONLY = process.argv.includes('--plan')
const UA = 'SkyrimAEModManager/1.0 (E2E-BATCH)'

mkdirSync(OUT_DIR, { recursive: true })
try {
  rmSync(LOGFILE, { force: true })
} catch {}
function log(...a) {
  const line = a.join(' ')
  console.log(line)
  try {
    appendFileSync(LOGFILE, line + '\n')
  } catch {}
}
const ts = () => new Date().toISOString().slice(11, 19)
const fail = (m) => {
  log('\n✗ BATCH ERRORE:', m)
  process.exit(1)
}

function readApiKey() {
  if (process.env.NEXUS_API_KEY?.trim()) return process.env.NEXUS_API_KEY.trim()
  const f = join(ROOT, 'secrets', 'nexus.key')
  if (existsSync(f)) {
    const k = readFileSync(f, 'utf8').trim()
    if (k) return k
  }
  return null
}

// ── Nexus API ────────────────────────────────────────────────────────────────
async function nexusJson(url, apiKey) {
  const res = await fetch(url, { headers: { apikey: apiKey, Accept: 'application/json', 'User-Agent': UA } })
  if (res.status === 403 || res.status === 401) throw new Error('403/401 (chiave non valida o non Premium)')
  if (res.status === 404) throw new Error('404')
  if (res.status === 429) throw new Error('429 rate-limit')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
// file metadata (real filename → extension) WITHOUT generating a download link
async function fileExtension(modId, fileId, apiKey) {
  try {
    const data = await nexusJson(
      `https://api.nexusmods.com/v1/games/${GAME}/mods/${modId}/files.json`,
      apiKey,
    )
    const f = (data?.files || []).find((x) => x.file_id === fileId)
    const name = f?.file_name || ''
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
    return { ext, name }
  } catch {
    return { ext: '', name: '' }
  }
}
async function resolveCdnLink(modId, fileId, apiKey) {
  const data = await nexusJson(
    `https://api.nexusmods.com/v1/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`,
    apiKey,
  )
  const hit = Array.isArray(data) ? data.find((l) => l && typeof l.URI === 'string') : null
  if (!hit) throw new Error('risposta priva di URI')
  return hit.URI
}
function filenameFromUri(uri, fallback) {
  try {
    return decodeURIComponent(new URL(uri).pathname).split('/').pop() || fallback
  } catch {
    return fallback
  }
}

// ── resumable download (mirrors planResume from downloadStream.ts) ─────────────
class Counter extends Transform {
  constructor(cb) {
    super()
    this.cb = cb
  }
  _transform(c, _e, done) {
    this.cb(c.length)
    this.push(c)
    done()
  }
}
// abortAtBytes: for the self-test — throw after N new bytes to simulate a drop.
async function resumableDownload(uri, dest, { onProgress, abortAtBytes } = {}) {
  const part = dest + '.part'
  const partSize = existsSync(part) ? statSync(part).size : 0
  const headers = { 'User-Agent': UA }
  if (partSize > 0) headers.Range = `bytes=${partSize}-`

  const res = await fetch(uri, { headers })
  if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`)
  // 206 + existing part → append/resume; otherwise restart cleanly
  const append = res.status === 206 && partSize > 0
  const contentLength = Number(res.headers.get('content-length') || 0)
  const crTotal = Number(res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] || 0) // Number(): no bitwise overflow on >2 GB
  const total = crTotal || (append ? partSize + contentLength : contentLength)

  let downloaded = append ? partSize : 0
  let sinceStart = 0,
    lastPct = -1,
    aborted = false
  const counter = new Counter((n) => {
    downloaded += n
    sinceStart += n
    if (abortAtBytes && sinceStart >= abortAtBytes && !aborted) {
      aborted = true
      counter.destroy(new Error('SIMULATED_DROP'))
    }
    if (total) {
      const pct = Math.floor((downloaded / total) * 100)
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct
        onProgress?.(downloaded, total)
      }
    }
  })
  const writer = createWriteStream(part, { flags: append ? 'a' : 'w' })
  try {
    await pipeline(Readable.fromWeb(res.body), counter, writer)
  } catch (e) {
    if (e.message === 'SIMULATED_DROP' || /premature|aborted/i.test(e.message)) {
      const t = { partial: true, resumed: append, partSize: statSync(part).size }
      return t
    }
    throw e
  }
  if (total > 0 && statSync(part).size !== total)
    throw new Error(`incompleto: ${statSync(part).size}/${total}`)
  renameSync(part, dest) // atomic promote — only a COMPLETE file gets the final name
  return { partial: false, resumed: append, bytes: statSync(dest).size, total }
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
function sevenZipTest(a) {
  const r = spawnSync(SEVENZIP, ['t', a, '-y'], { encoding: 'utf8' })
  return r.status === 0 && /Everything is Ok/i.test(r.stdout || '')
}
function sevenZipExtract(a, d) {
  mkdirSync(d, { recursive: true })
  return spawnSync(SEVENZIP, ['x', a, '-y', `-o${d}`], { encoding: 'utf8' }).status === 0
}
function countFiles(dir) {
  let n = 0,
    b = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const s = countFiles(p)
      n += s.n
      b += s.b
    } else {
      n++
      b += statSync(p).size
    }
  }
  return { n, b }
}

// ── batch discovery ──────────────────────────────────────────────────────────
async function discoverBatch(apiKey) {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'))
  const withId = b.deduped.filter((m) => m.fileId && m.md5)
  // small candidates (15–95 MB) spread for format variety, + big candidates (>1 GB)
  const small = withId
    .filter((m) => m.fileSize >= 15 * MB && m.fileSize <= 95 * MB)
    .sort((a, b) => a.fileSize - b.fileSize)
  const big = withId.filter((m) => m.fileSize > 1 * GB).sort((a, b) => a.fileSize - b.fileSize)

  const want = ['zip', '7z', 'rar']
  const picked = new Map() // ext → mod
  let probes = 0
  log(`${ts()} ▸ scoperta formati (probe files.json, budget 40)…`)
  for (const m of small) {
    if (probes >= 40 || want.every((w) => picked.has(w))) break
    const { ext } = await fileExtension(m.modId, m.fileId, apiKey)
    probes++
    if (want.includes(ext) && !picked.has(ext)) {
      picked.set(ext, { ...m, ext })
      log(`${ts()}   trovato .${ext}: ${m.name.slice(0, 40)} (${(m.fileSize / MB).toFixed(0)} MB)`)
    }
  }
  const batch = [...picked.values()]
  // big file (any format) — proves multi-GB + resume path
  if (big.length) {
    const m = big[0]
    const { ext } = await fileExtension(m.modId, m.fileId, apiKey)
    batch.push({ ...m, ext: ext || '?', big: true })
    log(`${ts()}   file pesante .${ext || '?'}: ${m.name.slice(0, 40)} (${(m.fileSize / GB).toFixed(2)} GB)`)
  }
  const missing = want.filter((w) => !picked.has(w))
  if (missing.length)
    log(
      `${ts()} ⚠ formati non trovati nel budget probe: ${missing.map((x) => '.' + x).join(', ')} (procedo con quelli disponibili — niente invenzioni)`,
    )
  return batch
}

// ── concurrency pool ─────────────────────────────────────────────────────────
async function pool(items, n, worker) {
  const results = new Array(items.length)
  let i = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      results[idx] = await worker(items[idx], idx).catch((e) => ({
        ok: false,
        error: e.message,
        mod: items[idx],
      }))
    }
  })
  await Promise.all(runners)
  return results
}

// ── per-mod pipeline ─────────────────────────────────────────────────────────
async function processMod(m, apiKey, { resumeTest = false } = {}) {
  const tag = `[${m.modId}/${m.fileId} .${m.ext}]`
  try {
    const uri = await resolveCdnLink(m.modId, m.fileId, apiKey)
    const fname = filenameFromUri(uri, `mod_${m.modId}_${m.fileId}.${m.ext || 'bin'}`)
    const dest = join(OUT_DIR, fname)
    rmSync(dest, { force: true })
    rmSync(dest + '.part', { force: true })

    if (resumeTest) {
      log(`${ts()} ${tag} ⏯ self-test resume: scarico ~40% poi simulo caduta…`)
      const first = await resumableDownload(uri, dest, { abortAtBytes: Math.floor(m.fileSize * 0.4) })
      if (!first.partial || !existsSync(dest + '.part'))
        throw new Error('il .part non è sopravvissuto alla caduta simulata')
      log(`${ts()} ${tag}   caduta a ${(first.partSize / MB).toFixed(1)} MB → .part presente, RIPRENDO…`)
      const second = await resumableDownload(uri, dest, {
        onProgress: (d, t) =>
          log(
            `${ts()} ${tag}   resume ${Math.floor((d / t) * 100)}% (${(d / MB).toFixed(0)}/${(t / MB).toFixed(0)} MB)`,
          ),
      })
      if (!second.resumed) throw new Error('il resume non ha usato Range (ha ricominciato da zero)')
      log(`${ts()} ${tag}   ✓ resume completato via HTTP Range`)
    } else {
      log(`${ts()} ${tag} ⬇ download…`)
      await resumableDownload(uri, dest, {
        onProgress: (d, t) =>
          log(
            `${ts()} ${tag}   ${Math.floor((d / t) * 100)}% (${(d / MB).toFixed(0)}/${(t / MB).toFixed(0)} MB)`,
          ),
      })
    }

    const got = await md5File(dest)
    if (got.toLowerCase() !== String(m.md5).toLowerCase())
      throw new Error(`md5 NON combacia (atteso ${m.md5}, ottenuto ${got})`)
    log(`${ts()} ${tag} ✓ md5 OK`)
    if (!sevenZipTest(dest)) throw new Error('7z test fallito (archivio corrotto)')
    const destDir = join(STOCKGAME_MODS, `${m.modId}-${fname.replace(/\.[^.]+$/, '')}`)
    rmSync(destDir, { recursive: true, force: true })
    if (!sevenZipExtract(dest, destDir)) throw new Error('estrazione fallita')
    const tree = countFiles(destDir)
    if (tree.n === 0) throw new Error('estrazione vuota')
    log(`${ts()} ${tag} ✓ estratti ${tree.n} file (${(tree.b / MB).toFixed(1)} MB)`)
    return { ok: true, mod: m, fname, files: tree.n, mb: statSync(dest).size / MB }
  } catch (e) {
    log(`${ts()} ${tag} ✗ ${e.message}`)
    return { ok: false, error: e.message, mod: m }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
;(async () => {
  log(`═══ E2E-BATCH @ ${new Date().toISOString()} ═══`)
  if (!existsSync(SEVENZIP)) fail('7-Zip non trovato')
  const apiKey = readApiKey()
  if (!apiKey) fail('nessuna chiave (secrets/nexus.key o $NEXUS_API_KEY)')

  const batch = await discoverBatch(apiKey)
  if (!batch.length) fail('nessun target selezionato')
  log(`\n${ts()} ▸ BATCH (${batch.length} mod, concorrenza ${CONCURRENCY}):`)
  for (const m of batch)
    log(`   • .${m.ext}${m.big ? ' [BIG]' : ''}  ${(m.fileSize / MB).toFixed(0)} MB  ${m.name.slice(0, 46)}`)
  const totalGB = batch.reduce((a, m) => a + m.fileSize, 0) / GB
  log(`   peso totale stimato: ${totalGB.toFixed(2)} GB`)
  if (PLAN_ONLY) {
    log('\n(--plan: nessun download)')
    return
  }

  // resume self-test on the smallest small file; the rest run concurrently as normal
  const small = batch.filter((m) => !m.big).sort((a, b) => a.fileSize - b.fileSize)
  const resumeTarget = small[0]
  log(`\n${ts()} ━━ FASE 1: self-test resume su ${resumeTarget?.name.slice(0, 40)} ━━`)
  const r0 = resumeTarget ? await processMod(resumeTarget, apiKey, { resumeTest: true }) : null

  const rest = batch.filter((m) => m !== resumeTarget)
  log(`\n${ts()} ━━ FASE 2: download concorrenti (${rest.length} mod, ${CONCURRENCY} simultanei) ━━`)
  const results = await pool(rest, CONCURRENCY, (m) => processMod(m, apiKey))

  const all = [r0, ...results].filter(Boolean)
  const ok = all.filter((r) => r.ok),
    ko = all.filter((r) => !r.ok)
  log(`\n═══ ESITO BATCH ═══`)
  log(
    `   OK: ${ok.length}/${all.length}  ·  formati: ${[...new Set(ok.map((r) => '.' + r.mod.ext))].join(' ')}`,
  )
  for (const r of ok)
    log(`   ✓ .${r.mod.ext}${r.mod.big ? ' [BIG]' : ''} ${r.mod.name.slice(0, 40)} — ${r.files} file`)
  for (const r of ko) log(`   ✗ ${r.mod?.name?.slice(0, 40)} — ${r.error}`)
  if (ko.length) process.exitCode = 1
  else log(`\n✅ BATCH SUPERATO — pipeline solida su formati misti + file pesante + resume`)
})().catch((e) => fail(e?.stack || String(e)))
