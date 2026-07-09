import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import type Store from 'electron-store'
import { logger } from './logger'
import { extractArchive, verifyArchiveHash } from './install/extract'
import { bundled7zaPath, resolveRar7z } from './install/sevenZip'
import { getFreeSpace, assessDiskSpace, estimateInstallFootprint, formatBytes } from './install/diskSpace'

interface DownloadRow {
  id: number
  mod_id: number | null
  name: string
  file_path: string | null
  status: string
}

function sanitizeFolder(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'mod'
  )
}

export interface InstallHooks {
  onComplete?: (downloadId: number) => void
  onError?: (downloadId: number, error: string) => void
}

export function initInstallManager(
  db: Database.Database,
  win: () => BrowserWindow | null,
  store: Store,
  hooks?: InstallHooks,
) {
  // Where extracted mods are deployed. Defaults under userData/mods so the feature
  // works out of the box; users point it at their MO2 `mods` folder in Settings.
  const modsRoot = () => (store.get('modsPath') as string) || join(app.getPath('userData'), 'mods')

  function send(channel: string, payload: Record<string, unknown>) {
    win()?.webContents.send(channel, payload)
  }

  // The expected sha256 for a delta-driven download comes from the signed manifest
  // (delta_changeset.to_file_hash). When present we verify the archive BEFORE
  // extracting — a corrupt/tampered multi-GB archive is rejected, never unpacked.
  function expectedHash(downloadId: number): string | null {
    try {
      const row = db
        .prepare(
          'SELECT to_file_hash AS h FROM delta_changeset WHERE download_id=? AND to_file_hash IS NOT NULL LIMIT 1',
        )
        .get(downloadId) as { h: string } | undefined
      return row?.h ?? null
    } catch {
      return null
    }
  }

  async function runInstall(downloadId: number) {
    const row = db.prepare('SELECT * FROM downloads WHERE id=?').get(downloadId) as DownloadRow | undefined
    if (!row) return { success: false, error: 'Download non trovato' }
    if (!row.file_path || !existsSync(row.file_path)) {
      return { success: false, error: 'Archivio scaricato non trovato' }
    }

    const modName = sanitizeFolder(row.name)
    const destDir = join(modsRoot(), modName)
    // Se destDir esisteva già (reinstallazione/update sopra una mod funzionante),
    // il cleanup su errore NON deve raderla al suolo: meglio una cartella in stato
    // misto segnalata nell'errore che distruggere l'installazione precedente.
    const destExisted = existsSync(destDir)

    db.prepare("UPDATE downloads SET status='installing' WHERE id=?").run(downloadId)

    try {
      // 1) Pre-extraction integrity: hash the (possibly multi-GB) archive by streaming.
      const expected = expectedHash(downloadId)
      if (expected) {
        send('install:progress', { id: downloadId, modName, stage: 'verifying' })
        const v = await verifyArchiveHash(row.file_path, expected)
        if (!v.ok) {
          throw new Error(
            `Hash archivio non corrisponde (atteso ${expected.slice(0, 12)}…, ottenuto ${v.actual.slice(0, 12)}…): download corrotto o manomesso`,
          )
        }
      }

      // 2) Disk-space pre-flight: refuse early if the mods volume can't hold the
      // extracted output (estimated from the archive size), rather than failing
      // cryptically mid-unpack. Fail-open: an unreadable probe (Infinity) never blocks.
      const archiveBytes = statSync(row.file_path).size
      const free = await getFreeSpace(modsRoot())
      const space = assessDiskSpace({
        requiredBytes: estimateInstallFootprint(archiveBytes),
        freeBytes: free,
      })
      if (!space.ok) {
        throw new Error(
          `Spazio su disco insufficiente per "${row.name}": servono ~${formatBytes(space.requiredBytes)}, liberi ${formatBytes(space.freeBytes)} (mancano ${formatBytes(space.shortfallBytes)})`,
        )
      }

      // 3) Streaming extraction with live progress (7-Zip preferred; safe zip fallback).
      send('install:progress', { id: downloadId, modName, stage: 'extracting', percent: 0 })
      const { method } = await extractArchive(row.file_path, destDir, {
        bundled7zaPath: bundled7zaPath(), // .7z/.zip: no config needed
        full7zPath: resolveRar7z(store.get('sevenZipPath') as string | undefined) ?? undefined, // .rar: system 7-Zip → bundled full fallback
        onProgress: (percent) =>
          send('install:progress', { id: downloadId, modName, stage: 'extracting', percent }),
      })

      if (row.mod_id) {
        db.prepare(
          'UPDATE mods SET is_installed=1, install_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        ).run(destDir, row.mod_id)
      }
      db.prepare("UPDATE downloads SET status='completed' WHERE id=?").run(downloadId)
      logger.info(
        'install',
        `Installato "${row.name}" → ${destDir} (${method}${expected ? ', hash ok' : ''})`,
      )
      send('install:complete', { id: downloadId, modId: row.mod_id, path: destDir })
      hooks?.onComplete?.(downloadId) // advance any linked delta changeset row
      return { success: true, path: destDir }
    } catch (err: unknown) {
      const msg = (err as Error).message
      // Remove a half-written mod folder so a retry starts clean and the profile is
      // never left with a partially-extracted mod — ma SOLO se la cartella è stata
      // creata da QUESTA installazione: una reinstallazione fallita non deve
      // cancellare la versione precedente funzionante.
      if (!destExisted) {
        try {
          rmSync(destDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      } else {
        logger.warn(
          'install',
          `"${row.name}": estrazione fallita sopra una installazione esistente — cartella lasciata in ${destDir}, verifica manuale consigliata`,
        )
      }
      db.prepare("UPDATE downloads SET status='failed', error=? WHERE id=?").run(
        `Installazione: ${msg}`,
        downloadId,
      )
      logger.error('install', `Estrazione fallita per "${row.name}": ${msg}`)
      send('install:error', { id: downloadId, error: msg })
      hooks?.onError?.(downloadId, msg)
      return { success: false, error: msg }
    }
  }

  // Allow the renderer to (re)trigger an install for an already-downloaded archive.
  ipcMain.handle('install:run', (_e, downloadId: number) => runInstall(downloadId))

  return { runInstall }
}
