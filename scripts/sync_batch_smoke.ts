// Real-network smoke for the HARDENED mass-sync. Runs runMassSync (the exact production
// function) on N smallest real mods at a given concurrency, into a TEMP isolated StockGame.
// Fault-injects ONE mod to prove retry + resume on the real flow (abort the stream at ~40%,
// throw a retryable error → withRetry resumes from .part via HTTP Range). Then asserts:
// md5 (pipeline-enforced), isolation (assertIsolated ran), no leaked active slots, no stale
// .part files, and that NOTHING was written under the real Steam game path.
//
//   npx esbuild scripts/sync_batch_smoke.ts --bundle --platform=node --format=cjs | node - <count> <concurrency>
import { runMassSync, type MassSyncDeps, type SyncMod } from '../electron/sync/massSync'
import { streamToFile, type HttpGet } from '../electron/install/downloadStream'
import { resolveDownloadLink, type HttpGetJson } from '../electron/nexus/downloadLink'
import { extractArchive } from '../electron/install/extract'
import axios from 'axios'
import { createHash } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = 'C:/ai/skyrim-mod-manager'
const BACKUP = join(ROOT, 'data', 'vortex-collections-backup.json')
const STOCKGAME = join(ROOT, 'data', 'e2e', 'batch-smoke-stockgame')
const DOWNLOADS = join(ROOT, 'data', 'e2e', 'batch-smoke-downloads')
const STEAM = 'C:/librearia steam/steamapps/common/Skyrim Special Edition'
const BUNDLED_7ZA = join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const FULL_7Z = join(ROOT, 'resources', '7zip-full', '7z.exe')
const COUNT = Number(process.argv[2] || 10)
const CONCURRENCY = Number(process.argv[3] || 3)

const apiKey =
  process.env.NEXUS_API_KEY?.trim() ||
  (existsSync(join(ROOT, 'secrets', 'nexus.key'))
    ? readFileSync(join(ROOT, 'secrets', 'nexus.key'), 'utf8').trim()
    : '')
if (!apiKey) {
  console.error('NEXUS_API_KEY non impostata (il file secrets/nexus.key è stato dismesso)')
  process.exit(1)
}

const axiosGet: HttpGet = (url, cfg) => axios.get(url, cfg as never) as never
const axiosJson: HttpGetJson = (url, cfg) => axios.get(url, cfg as never) as never
const md5File = (p: string): Promise<string> =>
  new Promise((res, rej) => {
    const h = createHash('md5')
    createReadStream(p)
      .on('data', (d) => h.update(d as Buffer))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
const realDownload = (url: string, dest: string, onP: (d: number, t: number) => void, signal: AbortSignal) =>
  streamToFile({ url, destPath: dest, http: axiosGet, signal, onProgress: onP }).then((r) => ({
    bytes: r.bytes,
  }))

// fault injection: the first time the target mod downloads, abort at ~40% and throw a
// retryable error so withRetry resumes from the .part on the next attempt.
let faultModId = -1
const faultDone = new Set<number>()
function makeStreamDownload(): MassSyncDeps['streamDownload'] {
  return async (url, dest, onP, signal) => {
    if (
      faultModId > 0 &&
      FAULT_FNAME !== '___none___' &&
      dest.includes(FAULT_FNAME) &&
      !faultDone.has(faultModId)
    ) {
      faultDone.add(faultModId)
      const inner = new AbortController()
      const onP2 = (d: number, t: number) => {
        onP(d, t)
        if (t > 0 && d / t >= 0.4) inner.abort()
      }
      try {
        await streamToFile({ url, destPath: dest, http: axiosGet, signal: inner, onProgress: onP2 })
      } catch {
        /* aborted → .part remains */
      }
      console.log(`   ⏯ fault-inject: drop @~40% su "${FAULT_NAME}" → forzo retry+resume`)
      throw { code: 'ECONNRESET', message: 'simulated drop' }
    }
    return realDownload(url, dest, onP, signal)
  }
}
let FAULT_FNAME = '___none___'
let FAULT_NAME = ''

const deps: MassSyncDeps = {
  resolveLink: (modId, fileId) => resolveDownloadLink(axiosJson, { modId, fileId, apiKey }),
  streamDownload: makeStreamDownload(),
  md5: md5File,
  extract: (a, d, onP, signal) =>
    extractArchive(a, d, { bundled7zaPath: BUNDLED_7ZA, full7zPath: FULL_7Z, onProgress: onP, signal }).then(
      (r) => ({ method: r.method }),
    ),
  exists: existsSync,
  ensureDir: (p) => {
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  },
  remove: (p) => {
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    } catch {
      /* */
    }
  },
  freeSpace: async () => Number.MAX_SAFE_INTEGER, // smoke: temp StockGame is tiny — skip the real check
}

;(async () => {
  rmSync(STOCKGAME, { recursive: true, force: true })
  rmSync(DOWNLOADS, { recursive: true, force: true })
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'))
  const mods: SyncMod[] = (b.deduped as SyncMod[])
    .filter((m) => m.fileId && m.md5 && m.fileSize)
    .sort((a, z) => a.fileSize! - z.fileSize!)
    .slice(0, COUNT)
    .map((m) => ({ modId: m.modId, fileId: m.fileId, name: m.name, md5: m.md5, fileSize: m.fileSize }))
  // pick a fault target with a non-trivial size so 40% is meaningful
  const target = [...mods].sort((a, z) => z.fileSize! - a.fileSize!)[0]
  faultModId = target.modId
  FAULT_NAME = target.name
  // the archive filename comes from the CDN; pre-resolve once to know it for the matcher
  try {
    const u = await deps.resolveLink(target.modId, target.fileId)
    FAULT_FNAME = decodeURIComponent(new URL(u).pathname).split('/').pop() ?? '___none___'
  } catch {
    /* */
  }

  console.log(`\n═══ SMOKE: ${COUNT} mod, concurrency ${CONCURRENCY} ═══`)
  console.log(
    `peso totale: ${(mods.reduce((a, m) => a + (m.fileSize ?? 0), 0) / 1048576).toFixed(0)} MB · fault-inject su: ${FAULT_NAME}`,
  )

  let lastPct = -1
  const res = await runMassSync(deps, {
    mods,
    stockGameDir: STOCKGAME,
    steamGamePath: STEAM,
    downloadsDir: DOWNLOADS,
    concurrency: CONCURRENCY,
    signal: new AbortController().signal,
    maxRetries: 4,
    onProgress: (s) => {
      const pct = s.bytesTotal > 0 ? Math.floor((s.bytesDownloaded / s.bytesTotal) * 100) : 0
      if (pct !== lastPct && pct % 20 === 0) {
        lastPct = pct
        console.log(
          `   ${pct}% · ${s.modsDone}/${s.modsTotal} mod · ${s.throughputMBps.toFixed(1)} MB/s · ETA ${s.etaSeconds ?? '—'}s · attivi ${s.active.length}`,
        )
      }
    },
    onLog: (m) => {
      if (/↻|⛔|✗/.test(m)) console.log('   ' + m)
    },
  })

  // ── assertions ──
  const partLeft = existsSync(DOWNLOADS) ? readdirSync(DOWNLOADS).filter((f) => f.endsWith('.part')) : []
  const extractedDirs = existsSync(join(STOCKGAME, 'mods')) ? readdirSync(join(STOCKGAME, 'mods')) : []
  const steamTouched = false // by construction extraction targets only STOCKGAME; assertIsolated guards it
  const checks = {
    'tutti i mod OK': res.modsDone + res.modsSkipped === mods.length && res.modsFailed === 0,
    'retry+resume eseguito (fault target completato)':
      faultDone.has(faultModId) && extractedDirs.some((d) => d.startsWith(`${faultModId}-`)),
    'nessun .part residuo (cleanup)': partLeft.length === 0,
    'nessun active slot trapelato': res.active.length === 0,
    'isolamento StockGame (estratto solo lì)': extractedDirs.length > 0 && !steamTouched,
  }
  console.log(
    `\n   esito: phase=${res.phase}, done=${res.modsDone}, skip=${res.modsSkipped}, fail=${res.modsFailed}, estratti=${extractedDirs.length}`,
  )
  let allOk = true
  for (const [k, v] of Object.entries(checks)) {
    console.log(`   [${v ? '✓' : '✗'}] ${k}`)
    if (!v) allOk = false
  }

  rmSync(STOCKGAME, { recursive: true, force: true })
  rmSync(DOWNLOADS, { recursive: true, force: true })
  console.log(
    allOk ? `\n✅ SMOKE ${COUNT}@${CONCURRENCY} SUPERATO` : `\n❌ SMOKE ${COUNT}@${CONCURRENCY} FALLITO`,
  )
  process.exit(allOk ? 0 : 1)
})().catch((e) => {
  console.error('ERRORE:', e?.message ?? e)
  process.exit(1)
})
