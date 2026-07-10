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
import { join } from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

const ROOT = 'C:/ai/skyrim-mod-manager'
// La chiave arriva SOLO dall'ambiente: il file secrets/nexus.key in chiaro è stato
// dismesso (l'app usa il secret store cifrato; gli script usano $NEXUS_API_KEY).
const KEY = process.env.NEXUS_API_KEY?.trim()
if (!KEY) {
  console.error(
    'NEXUS_API_KEY non impostata. PowerShell:  $env:NEXUS_API_KEY = Read-Host -MaskInput "API key"',
  )
  process.exit(1)
}
const SEVENZIP = join(ROOT, 'resources', '7zip-full', '7z.exe')
const DL = join(ROOT, 'data', 'boot_cache', 'downloads')
const SG = join(ROOT, 'data', 'StockGame', 'mods')
const LOG = join(ROOT, 'data', 'boot_cache', 'boot.log')
const GAME = 'skyrimspecialedition',
  UA = 'SkyrimAEModManager/1.0'
mkdirSync(DL, { recursive: true })
mkdirSync(SG, { recursive: true })
try {
  rmSync(LOG, { force: true })
} catch {}
const log = (...a) => {
  const l = a.join(' ')
  console.log(l)
  try {
    appendFileSync(LOG, l + '\n')
  } catch {}
}

const PH = [
  /\bskse\b|address.?library|engine.?fixes|\.net.?script|crash.?log|\bussep\b|unofficial.?skyrim|backported|scrambled.?bugs|po3.?tweaks|powerofthree.?s.?tweaks/i,
  /papyrusutil|jcontainers|consoleutil|\bspid\b|\bkid\b|base.?object.?swapper|\bbos\b|dynamic.?if|\bmfg\b|fuz.?ro|\bfiss\b|\bpo3\b|powerofthree|keyword|distributor|payload.?interpreter|animation.?motion|\bdtry\b|more.?informative.?console|custom.?skills/i,
  /skyui|\bmcm\b|racemenu|\bui\b|interface|\bfont\b|quick.?loot|\bmap\b|sovngarde|dear.?diary|untarnished|infinity.?ui|true.?hud|nordic.?ui|compass|widget|\bhud\b|inventory/i,
]
const all = JSON.parse(readFileSync(join(ROOT, 'data', 'vortex-collections-backup.json'), 'utf8')).deduped
const boot = all.filter((m) => m.fileId && PH.some((re) => re.test(m.name || '')))
const sani = (s) =>
  s
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'mod'
const md5File = (p) =>
  new Promise((res, rej) => {
    const h = createHash('md5')
    createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
let apiRemaining = '?'
async function resolve(modId, fileId) {
  const u = `https://api.nexusmods.com/v1/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`
  const r = await fetch(u, { headers: { apikey: KEY, Accept: 'application/json', 'User-Agent': UA } })
  apiRemaining = r.headers.get('x-rl-daily-remaining') || apiRemaining
  if (!r.ok) throw new Error('resolve HTTP ' + r.status)
  const d = await r.json()
  const h = Array.isArray(d) ? d.find((x) => x && x.URI) : null
  if (!h) throw new Error('no URI')
  return h.URI
}
async function dl(uri, dest) {
  const r = await fetch(uri, { headers: { 'User-Agent': UA } })
  if (!r.ok || !r.body) throw new Error('dl HTTP ' + r.status)
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest + '.part'))
  renameSync(dest + '.part', dest)
  return statSync(dest).size
}
const ext = (a, d) => {
  mkdirSync(d, { recursive: true })
  return spawnSync(SEVENZIP, ['x', a, '-y', '-bd', '-o' + d], { encoding: 'utf8' }).status === 0
}
const fnameFromUri = (u, fb) => {
  try {
    return decodeURIComponent(new URL(u).pathname).split('/').pop() || fb
  } catch {
    return fb
  }
}
function plugins(dir) {
  let n = 0
  const st = [dir]
  while (st.length) {
    const x = st.pop()
    let e
    try {
      e = readdirSync(x, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of e) {
      const p = join(x, f.name)
      if (f.isDirectory()) st.push(p)
      else if (/\.es[pml]$/i.test(f.name)) n++
    }
  }
  return n
}

let ok = 0,
  fail = 0,
  plug = 0
const failed = []
async function one(m) {
  const tag = `[${m.modId}/${m.fileId}]`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const uri = await resolve(m.modId, m.fileId)
      const fn = sani(fnameFromUri(uri, `mod_${m.modId}.7z`))
      const arc = join(DL, fn)
      if (!existsSync(arc)) await dl(uri, arc)
      if (m.md5) {
        const got = await md5File(arc)
        if (got.toLowerCase() !== m.md5.toLowerCase()) {
          rmSync(arc, { force: true })
          throw new Error('md5 mismatch')
        }
      }
      const dest = join(SG, `${m.modId}-${sani((m.name || '').replace(/\.[^.]+$/, ''))}`)
      if (!existsSync(dest)) {
        if (!ext(arc, dest)) throw new Error('extract fail')
      }
      plug += plugins(dest)
      ok++
      log(`✓ ${tag} ${(m.name || '').slice(0, 40)}`)
      return
    } catch (e) {
      if (attempt === 2) {
        fail++
        failed.push({ id: m.modId, e: e.message })
        log(`✗ ${tag} ${(m.name || '').slice(0, 34)}: ${e.message}`)
      } else await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
}
;(async () => {
  log(`EXEC-BOOT: ${boot.length} mod · concorrenza 4 · ${new Date().toISOString()}`)
  let i = 0
  const worker = async () => {
    while (i < boot.length) {
      const idx = i++
      await one(boot[idx])
      if (idx % 25 === 0)
        log(`… ${ok + fail}/${boot.length} (ok ${ok}, fail ${fail}) API_rem=${apiRemaining}`)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  log(`\n=== EXEC-BOOT FINITO ===`)
  log(`FILES_DOWNLOADED=${ok}`)
  log(`FILES_FAILED=${fail}`)
  log(`API_REMAINING=${apiRemaining}`)
  log(`PLUGIN_COUNT=${plug}`)
  if (failed.length)
    log(
      'FAILED: ' +
        failed
          .slice(0, 20)
          .map((f) => f.id + '(' + f.e + ')')
          .join(', '),
    )
})()
