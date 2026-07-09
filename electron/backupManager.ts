import { ipcMain, app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { SqliteDb } from './db/sqlite'
import { createProfileBackup, listBackups, restoreProfileBackup, deleteBackup } from './backup/manager'

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

  ipcMain.handle('backup:restore', (_e, backupPath: string, targetProfileId: number) =>
    restoreProfileBackup(sdb, backupPath, targetProfileId),
  )

  ipcMain.handle('backup:delete', (_e, backupPath: string) => {
    deleteBackup(backupPath)
    return { success: true }
  })
}
