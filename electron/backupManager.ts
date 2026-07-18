import { ipcMain, app } from 'electron'
import { existsSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { SqliteDb } from './db/sqlite'
import { createProfileBackup, listBackups, restoreProfileBackup, deleteBackup } from './backup/manager'
import { validateInsideRoot, type RevealProbe } from './util/openTargets'
import { logger } from './logger'

// The renderer only ever gets a backupPath from backup:list, but the bridge takes
// a raw string — a compromised renderer could otherwise point restore/delete at any
// file on disk (arbitrary read into the DB, or arbitrary delete). Confine both to
// the app-managed backups dir, symlink/junction-safe (mirrors fs:reveal-folder).
const backupProbe: RevealProbe = { exists: existsSync, realpath: (p) => realpathSync.native(p) }

// Thin IPC layer over the hardened, unit-tested backup core (atomic write +
// checksum validation + optional whole-DB snapshot). Keeps the existing IPC API.

export function initBackupManager(db: Database.Database) {
  const backupDir = join(app.getPath('userData'), 'backups')
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
  const sdb = db as unknown as SqliteDb

  ipcMain.handle('backup:list', () => listBackups(backupDir))

  ipcMain.handle('backup:create', (_e, profileId: number, label?: string) =>
    createProfileBackup(sdb, backupDir, profileId, label),
  )

  // Pre-delta / destructive-op rollback point: also captures a whole-DB snapshot.
  ipcMain.handle('backup:auto', (_e, profileId: number) =>
    createProfileBackup(sdb, backupDir, profileId, 'auto', { snapshotDb: true }),
  )

  ipcMain.handle('backup:restore', (_e, backupPath: string, targetProfileId: number) => {
    const decision = validateInsideRoot(backupPath, backupDir, backupProbe)
    if (!decision.ok) {
      logger.warn('security', `backup:restore rifiutato (${decision.reason}): ${String(backupPath).slice(0, 120)}`)
      return { success: false, error: 'Backup non disponibile' }
    }
    return restoreProfileBackup(sdb, decision.path, targetProfileId)
  })

  ipcMain.handle('backup:delete', (_e, backupPath: string) => {
    const decision = validateInsideRoot(backupPath, backupDir, backupProbe)
    if (!decision.ok) {
      logger.warn('security', `backup:delete rifiutato (${decision.reason}): ${String(backupPath).slice(0, 120)}`)
      return { success: false, error: 'Backup non disponibile' }
    }
    deleteBackup(decision.path)
    return { success: true }
  })
}
