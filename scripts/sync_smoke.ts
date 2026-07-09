// Proof harness for item #7: runs the EXACT production function that
// ipcMain.handle('sync:start') invokes — runMassSync from electron/sync/massSync.ts —
// on ONE small real mod, printing every SyncProgress object. These printed objects ARE
// the payloads main.ts forwards verbatim on `mainWindow.webContents.send('sync:progress', s)`.
// Headless (no GUI) because the full GUI sync is gated behind the user's click + the key in
// app_secrets; here the key is read from secrets/nexus.key. Extracts into a TEMP StockGame.
import { runMassSync, type MassSyncDeps } from '../electron/sync/massSync'
import { streamToFile, type HttpGet } from '../electron/install/downloadStream'
import { resolveDownloadLink, type HttpGetJson } from '../electron/nexus/downloadLink'
import { extractArchive } from '../electron/install/extract'
import axios from 'axios'
import { createHash } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

const ROOT = 'C:/ai/skyrim-mod-manager'
const BACKUP = join(ROOT, 'data', 'vortex-collections-backup.json')
const STOCKGAME = join(ROOT, 'data', 'e2e', 'sync-smoke-stockgame') // TEMP isolated target
const DOWNLOADS = join(ROOT, 'data', 'e2e', 'sync-smoke-downloads')
const STEAM = 'C:/librearia steam/steamapps/common/Skyrim Special Edition' // real Steam path → exercises assertIsolated
const BUNDLED_7ZA = join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const FULL_7Z = join(ROOT, 'resources', '7zip-full', '7z.exe')

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

const deps: MassSyncDeps = {
  resolveLink: (modId, fileId) => resolveDownloadLink(axiosJson, { modId, fileId, apiKey }),
  streamDownload: (url, dest, onProgress, signal) =>
    streamToFile({ url, destPath: dest, http: axiosGet, signal, onProgress }).then((r) => ({
      bytes: r.bytes,
    })),
  md5: md5File,
  extract: (archive, destDir, onProgress, signal) =>
    extractArchive(archive, destDir, {
      bundled7zaPath: BUNDLED_7ZA,
      full7zPath: FULL_7Z,
      onProgress,
      signal,
    }).then((r) => ({ method: r.method })),
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
  const smallest = (
    b.deduped as { modId: number; fileId: number; name: string; md5?: string; fileSize?: number }[]
  )
    .filter((m) => m.fileId && m.md5 && m.fileSize)
    .sort((a, z) => a.fileSize! - z.fileSize!)[0]
  console.log(
    `TARGET: ${smallest.name} (modId ${smallest.modId}/file ${smallest.fileId}, ${(smallest.fileSize! / 1048576).toFixed(2)} MB)`,
  )
  console.log(`StockGame target: ${STOCKGAME}  |  Steam (per assertIsolated): ${STEAM}\n`)
  console.log('--- eventi sync:progress (gli stessi payload inviati su webContents.send) ---')

  let n = 0
  const final = await runMassSync(deps, {
    mods: [
      {
        modId: smallest.modId,
        fileId: smallest.fileId,
        name: smallest.name,
        md5: smallest.md5,
        fileSize: smallest.fileSize,
      },
    ],
    stockGameDir: STOCKGAME,
    steamGamePath: STEAM,
    downloadsDir: DOWNLOADS,
    concurrency: 1,
    signal: new AbortController().signal,
    onProgress: (s) => {
      n++
      console.log(
        `sync:progress #${n}`,
        JSON.stringify({
          phase: s.phase,
          modsDone: s.modsDone,
          modsTotal: s.modsTotal,
          modsFailed: s.modsFailed,
          modsSkipped: s.modsSkipped,
          active: s.active,
          lastMessage: s.lastMessage,
        }),
      )
    },
    onLog: (m) => console.log('  log:', m),
  })
  console.log(
    `\n--- ${n} eventi sync:progress emessi. Esito finale: ${final.phase} (ok ${final.modsDone}) ---`,
  )
  rmSync(STOCKGAME, { recursive: true, force: true })
  rmSync(DOWNLOADS, { recursive: true, force: true })
})().catch((e) => {
  console.error('ERRORE:', e?.message ?? e)
  process.exit(1)
})
