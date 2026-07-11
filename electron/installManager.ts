import { BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import { logger } from './logger'
import { columnExists } from './db/sqlite'
import { pickExpectedHash, type ExpectedHash } from './install/integrity'
import { TaskQueue } from './util/taskQueue'
import type { InstallerService, InstallResult, InstallProgress } from './install/installer'

/**
 * Mark a mod installed AND carry its auto-resolution metadata (deploy_category /
 * resolution_weight) from the signed catalog onto the installed record, so the
 * deployer decides file-conflict winners from real data — not mocks. Guarded:
 * pre-v8 schemas (no columns) fall back to the plain is_installed/install_path
 * update; a missing catalog row simply leaves the metadata NULL.
 */
function markInstalled(
  db: Database.Database,
  modId: number,
  nexusId: number,
  installPath: string | null,
): void {
  if (!columnExists(db, 'mods', 'deploy_category')) {
    db.prepare(
      'UPDATE mods SET is_installed=1, install_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    ).run(installPath, modId)
    return
  }
  let deployCategory: string | null = null
  let resolutionWeight: number | null = null
  try {
    const meta = db
      .prepare('SELECT deploy_category, resolution_weight FROM modlist_catalog WHERE nexus_id=?')
      .get(nexusId) as { deploy_category: string | null; resolution_weight: number | null } | undefined
    if (meta) {
      deployCategory = meta.deploy_category ?? null
      resolutionWeight = meta.resolution_weight ?? null
    }
  } catch {
    /* catalog table/columns absent → leave metadata NULL, deployer defaults apply */
  }
  db.prepare(
    'UPDATE mods SET is_installed=1, install_path=?, deploy_category=?, resolution_weight=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
  ).run(installPath, deployCategory, resolutionWeight, modId)
}

interface DownloadRow {
  id: number
  mod_id: number | null
  nexus_id: number | null
  file_id: number | null
  name: string
  file_path: string | null
  status: string
}

export interface InstallHooks {
  onComplete?: (downloadId: number) => void
  onError?: (downloadId: number, error: string) => void
}

/**
 * Install manager = the QUEUE/DB/EVENT adapter. It resolves a download row to a
 * mod identity, drives status transitions (installing → completed/failed), forwards
 * install:progress to the UI, and fires the delta hooks. The actual mechanics —
 * hash verify, staged extraction, recipe mapping, atomic commit — are delegated to
 * InstallerService.installMod (see electron/install/installer.ts), so this file no
 * longer touches archives or the mods folder directly.
 */
// Hard cap on simultaneous extractions/installs. Each install streams-hashes a (multi-GB)
// archive and 7-Zip-extracts it — CPU + disk heavy — so unbounded parallelism (one install per
// completing download) thrashes the machine. Default 3; overridable via the `concurrency` arg.
const DEFAULT_INSTALL_CONCURRENCY = 3

export function initInstallManager(
  db: Database.Database,
  win: () => BrowserWindow | null,
  installer: InstallerService,
  hooks?: InstallHooks,
  concurrency: number = DEFAULT_INSTALL_CONCURRENCY,
) {
  function send(channel: string, payload: Record<string, unknown>) {
    win()?.webContents.send(channel, payload)
  }

  // Bounded-concurrency pool: at most `concurrency` installs run at once; the rest wait as
  // 'queued'. The state hook drives the DB status + UI so the user sees installing vs queued.
  const pool = new TaskQueue({
    concurrency,
    onState: (id, state) => {
      const status = state === 'queued' ? 'queued' : 'installing'
      db.prepare('UPDATE downloads SET status=? WHERE id=?').run(status, id)
      const r = db.prepare('SELECT name FROM downloads WHERE id=?').get(id) as { name: string } | undefined
      send('install:progress', {
        id,
        modName: r?.name,
        stage: state === 'queued' ? 'queued' : 'verifying',
        percent: 0,
      })
    },
  })

  // Second-barrier expected hash for the installer (defense-in-depth behind the download
  // gate; also covers install:run on a pre-existing archive). Layered: the download row's
  // own file_hash/hash_algo (persisted trusted hash, or an md5_search-confirmed md5) first,
  // then the delta manifest's to_file_hash (sha256). The installer verifies BEFORE extracting.
  function expectedHash(downloadId: number): ExpectedHash | null {
    let downloadColumn: { value: string | null; algo: string | null } | null = null
    let deltaSha256: string | null = null
    try {
      const dl = db.prepare('SELECT file_hash, hash_algo FROM downloads WHERE id=?').get(downloadId) as
        | { file_hash: string | null; hash_algo: string | null }
        | undefined
      if (dl) downloadColumn = { value: dl.file_hash, algo: dl.hash_algo }
    } catch {
      /* pre-v9 schema without the columns */
    }
    try {
      const row = db
        .prepare(
          'SELECT to_file_hash AS h FROM delta_changeset WHERE download_id=? AND to_file_hash IS NOT NULL LIMIT 1',
        )
        .get(downloadId) as { h: string } | undefined
      deltaSha256 = row?.h ?? null
    } catch {
      /* delta_changeset optional */
    }
    return pickExpectedHash({ downloadColumn, deltaSha256 })
  }

  // The actual install work for ONE download (runs inside a pool slot). No-throw boundary.
  async function doInstall(downloadId: number): Promise<InstallResult> {
    const row = db.prepare('SELECT * FROM downloads WHERE id=?').get(downloadId) as DownloadRow | undefined
    if (!row) return { success: false, nexusId: 0, errorKind: 'not-found', error: 'Download non trovato' }
    if (!row.file_path || !existsSync(row.file_path)) {
      db.prepare("UPDATE downloads SET status='failed', error=? WHERE id=?").run(
        'Archivio scaricato non trovato',
        downloadId,
      )
      return { success: false, nexusId: row.nexus_id ?? 0, errorKind: 'not-found', error: 'Archivio scaricato non trovato' }
    }

    const nexusId = row.nexus_id ?? 0
    const expected = expectedHash(downloadId)
    // FAIL-CLOSED second gate. The download boundary persists a trusted hash onto every archive it
    // accepts (delta manifest sha256, or an md5_search-confirmed md5). A completed row with NO
    // resolvable hash therefore never passed that gate — e.g. a compromised renderer calling
    // downloads:add(status='completed', file_path=…) then install:run — so refuse to extract it.
    // The installer must never open on missing verification data (was: verify only `if (fileHash)`).
    if (!expected) {
      const msg = 'integrità non verificabile: nessun hash di riferimento (download non verificato dal gate)'
      db.prepare("UPDATE downloads SET status='failed', error=? WHERE id=?").run(
        `Installazione [hash]: ${msg}`,
        downloadId,
      )
      logger.warn('install', `Installazione rifiutata "${row.name}": ${msg}`)
      send('install:error', { id: downloadId, error: msg, errorKind: 'hash', integrity: true })
      hooks?.onError?.(downloadId, msg)
      return { success: false, nexusId, errorKind: 'hash', error: msg }
    }
    // (status is set to 'installing' by the pool's onState hook when the slot is acquired.)

    // Delegate the full pipeline (verify → stage → extract → map → commit) to the
    // InstallerService. It is a no-throw boundary AND cleans its own staging on any
    // failure, so this adapter only has to translate the Result into DB state + events.
    const res = await installer.installMod(nexusId, row.file_id ?? null, expected?.value ?? null, row.file_path, {
      hashAlgo: expected?.algo,
      // Namespace the on-disk folder by the stable nexus_id (mirrors massSync.modDestDir
      // `${modId}-${name}`): two different mods that sanitize to the SAME display name
      // no longer collide, so a reinstall can never wipe another mod's deployed files.
      // install_path is persisted from res.modPath, so the deployer stays consistent.
      modName: `${nexusId}-${row.name}`,
      onProgress: (p: InstallProgress) =>
        send('install:progress', {
          id: downloadId,
          modName: row.name,
          stage: p.stage,
          percent: p.percent,
          currentFile: p.currentFile,
        }),
      // A queued (re)install intentionally replaces a prior deployment of the same
      // mod. The installer only removes the final dir on a successful commit, so a
      // failed reinstall still leaves the previous working install intact.
      force: true,
    })

    if (res.success) {
      if (row.mod_id) {
        markInstalled(db, row.mod_id, nexusId, res.modPath ?? null)
      }
      db.prepare("UPDATE downloads SET status='completed' WHERE id=?").run(downloadId)
      logger.info(
        'install',
        `Installato "${row.name}" → ${res.modPath} (${res.strategy}/${res.recipeSource}, ${res.filesDeployed} file, ${res.method})`,
      )
      send('install:complete', { id: downloadId, modId: row.mod_id, path: res.modPath })
      hooks?.onComplete?.(downloadId)
      return res
    }

    const msg = res.error ?? 'errore sconosciuto'
    db.prepare("UPDATE downloads SET status='failed', error=? WHERE id=?").run(
      `Installazione [${res.errorKind}]: ${msg}`,
      downloadId,
    )
    logger.error('install', `Installazione fallita per "${row.name}" [${res.errorKind}]: ${msg}`)
    send('install:error', { id: downloadId, error: msg, errorKind: res.errorKind })
    hooks?.onError?.(downloadId, msg)
    return res
  }

  // Public entry: enqueue the install into the bounded pool. Excess installs wait as 'queued'
  // and start as slots free (see the pool's onState hook). doInstall is a no-throw boundary, so
  // the pooled task never rejects and a failing install frees its slot for the next one.
  function runInstall(downloadId: number): Promise<InstallResult> {
    return pool.enqueue(downloadId, () => doInstall(downloadId))
  }

  // Allow the renderer to (re)trigger an install for an already-downloaded archive.
  // No-throw boundary: an unexpected failure still returns an InstallResult.
  ipcMain.handle('install:run', async (_e, downloadId: number): Promise<InstallResult> => {
    try {
      return await runInstall(downloadId)
    } catch (err) {
      const msg = (err as Error).message
      logger.error('install', `install:run errore inatteso: ${msg}`)
      return { success: false, nexusId: 0, errorKind: 'db', error: msg }
    }
  })

  return { runInstall }
}
