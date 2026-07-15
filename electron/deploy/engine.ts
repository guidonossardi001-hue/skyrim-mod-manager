import { ipcMain } from 'electron'
import type { SqliteDb } from '../db/sqlite'
import {
  deployInstance,
  purgeInstance,
  previewDeploy,
  type DeployResult,
  type PurgeResult,
  type DeployPreview,
} from './deployer'

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
  // Cartella del plugins.txt DI SISTEMA (%LOCALAPPDATA%/Skyrim Special Edition). Opzionale: senza,
  // il deploy scrive solo la copia d'istanza (il gioco lanciato senza MO2 legge quella di sistema).
  resolveSystemPluginsDir?: () => string | null | undefined
  // Path del masterlist.json (regole "after" LOOT-like, soft). Opzionale: assente → zero regole.
  resolveMasterlistPath?: () => string | null | undefined
  // Path della cache locale del masterlist LOOT reale (fetch esplicita via masterlist:refresh).
  resolveLootMasterlistCachePath?: () => string | null | undefined
  // false quando il target di deploy è una directory CONDIVISA (Data del gioco reale): vieta
  // ogni pulizia/purge euristica nlink — solo manifest esatto. Default true (istanza dedicata).
  allowHeuristics?: () => boolean
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
        systemPluginsDir: opts.resolveSystemPluginsDir?.() ?? undefined,
        masterlistPath: opts.resolveMasterlistPath?.() ?? undefined,
        lootMasterlistCachePath: opts.resolveLootMasterlistCachePath?.() ?? undefined,
        allowHeuristicCleanup: opts.allowHeuristics?.() ?? true,
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

  // deploy:purge = rimozione ESATTA (manifest-based) di tutto ciò che il deploy ha creato
  // nell'istanza + ripristino del plugins.txt di sistema dal backup. L'euristica nlink resta
  // abilitata SOLO qui come fallback legacy: il target istanza è dedicato (mai vanilla dentro).
  ipcMain.handle('deploy:purge', (_e, profileId: number): PurgeResult & { error?: string } => {
    try {
      const dir = opts.resolveInstanceDataDir(profileId)
      if (!dir)
        return {
          success: false,
          manifestFound: false,
          filesRemoved: 0,
          junctionsRemoved: 0,
          dirsPruned: 0,
          skipped: 0,
          systemPluginsRestored: false,
          error: `profilo ${profileId} non trovato o percorso istanza non configurato`,
        }
      return purgeInstance(dir, { log: opts.log, allowHeuristic: opts.allowHeuristics?.() ?? true })
    } catch (e) {
      opts.log?.('warn', `deploy:purge errore inatteso: ${(e as Error).message}`)
      return {
        success: false,
        manifestFound: false,
        filesRemoved: 0,
        junctionsRemoved: 0,
        dirsPruned: 0,
        skipped: 0,
        systemPluginsRestored: false,
        error: (e as Error).message,
      }
    }
  })

  // deploy:prefer = risoluzione avanzata di una sovrascrittura SENZA disattivare nulla:
  // la mod scelta riceve resolution_weight = peso dell'avversaria + 1, così il planner
  // (categoria/peso/priorità) le fa vincere i file contesi al prossimo deploy. Chirurgico,
  // persistente e reversibile (basta preferire l'altra).
  ipcMain.handle(
    'deploy:prefer',
    (_e, profileId: number, preferredMod: string, overMod: string): { ok: boolean; newWeight?: number; error?: string } => {
      try {
        const get = opts.db.prepare(
          'SELECT resolution_weight FROM mods WHERE profile_id=? AND name=?',
        )
        const other = get.get(profileId, overMod) as { resolution_weight: number | null } | undefined
        const mine = get.get(profileId, preferredMod) as { resolution_weight: number | null } | undefined
        if (!other || !mine) return { ok: false, error: 'mod non trovata nel profilo' }
        const newWeight = Math.max(mine.resolution_weight ?? 0, (other.resolution_weight ?? 0) + 1)
        opts.db
          .prepare('UPDATE mods SET resolution_weight=? WHERE profile_id=? AND name=?')
          .run(newWeight, profileId, preferredMod)
        opts.log?.('info', `conflitti: "${preferredMod}" ora vince su "${overMod}" (peso ${newWeight})`)
        return { ok: true, newWeight }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )

  // deploy:preview = dry-run: conflitti file REALI (winner/loser dalle regole del planner),
  // budget plugin e problemi di load order — ZERO scritture. Alimenta la pagina Conflitti.
  ipcMain.handle('deploy:preview', (_e, profileId: number): DeployPreview => {
    try {
      return previewDeploy(opts.db, {
        profileId,
        stockGameDataDir: opts.resolveStockGameDataDir?.(profileId) ?? undefined,
        masterlistPath: opts.resolveMasterlistPath?.() ?? undefined,
        lootMasterlistCachePath: opts.resolveLootMasterlistCachePath?.() ?? undefined,
      })
    } catch (e) {
      opts.log?.('warn', `deploy:preview errore inatteso: ${(e as Error).message}`)
      return { ok: false, error: (e as Error).message }
    }
  })
}
