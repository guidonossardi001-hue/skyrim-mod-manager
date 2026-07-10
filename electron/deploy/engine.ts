import { ipcMain } from 'electron'
import type { SqliteDb } from '../db/sqlite'
import { deployInstance, type DeployResult } from './deployer'

// Thin ipcMain wrapper around deployInstance (same shape as catalog/engine.ts and
// install/engine.ts). Path resolution (profileId → instance Data dir) is injected
// from main.ts, which owns the store/app; the engine stays electron-config-agnostic.

export interface DeployEngineOptions {
  db: SqliteDb
  resolveInstanceDataDir: (profileId: number) => string | null
  // Base-game Data folder (StockGame/Data) scanned for Creation Club "System DLC"
  // content. Optional/injected so the engine stays config-agnostic; when omitted, CC
  // detection simply yields nothing (graceful).
  resolveStockGameDataDir?: (profileId: number) => string | null | undefined
  log?: (level: 'info' | 'warn', msg: string) => void
}

export function initDeployEngine(opts: DeployEngineOptions) {
  // deploy:run = resolve the profile's instance Data dir → build the override map,
  // link it in (hardlinks + junctions), write plugins.txt. deployInstance is already
  // a no-throw boundary; this extra try/catch keeps an unexpected low-level failure
  // (locked handle, native crash) from ever crossing the IPC channel.
  ipcMain.handle('deploy:run', async (event, profileId: number): Promise<DeployResult> => {
    try {
      const dir = opts.resolveInstanceDataDir(profileId)
      if (!dir) {
        opts.log?.('warn', `deploy:run: percorso istanza non risolvibile per profilo ${profileId}`)
        return {
          success: false,
          errorKind: 'db',
          error: `profilo ${profileId} non trovato o percorso istanza non configurato`,
        }
      }
      // Stream progress back to the renderer that invoked us. Guard the send: the
      // window may have closed mid-deploy, and a throwing sender must not abort the
      // deploy nor cross the no-throw boundary.
      return await deployInstance(opts.db, dir, {
        profileId,
        stockGameDataDir: opts.resolveStockGameDataDir?.(profileId) ?? undefined,
        log: opts.log,
        onProgress: (p) => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('deploy:progress', p)
          } catch {
            /* renderer gone — ignore */
          }
        },
      })
    } catch (e) {
      opts.log?.('warn', `deploy:run errore inatteso: ${(e as Error).message}`)
      return { success: false, errorKind: 'db', error: (e as Error).message }
    }
  })
}
