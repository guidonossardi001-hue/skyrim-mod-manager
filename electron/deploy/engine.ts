import { ipcMain } from 'electron'
import { copyFileSync, existsSync, openSync, readSync, writeSync, closeSync, statSync, readFileSync } from 'fs'
import type { SqliteDb } from '../db/sqlite'
import {
  deployInstance,
  purgeInstance,
  previewDeploy,
  planPluginFiles,
  type DeployResult,
  type PurgeResult,
  type DeployPreview,
} from './deployer'
import { classifyForEsl, pickToFlag, lightFlagBytes, TES4_FLAGS_OFFSET, type EslCandidate } from '../plugins/eslify'

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
  // Motore di deploy CONDIVISO: lo usano sia l'IPC `deploy:run` (bottone Deploy) sia la
  // riparazione automatica pre-avvio. Unica sede in cui si costruiscono le DeployOptions —
  // duplicarle nel main significherebbe farle divergere in silenzio dal percorso manuale.
  // deployInstance è già un confine no-throw; il try/catch qui copre anche i risolutori.
  const runDeploy = async (
    profileId: number,
    onProgress?: (p: unknown) => void,
  ): Promise<DeployResult> => {
    try {
      const dir = opts.resolveInstanceDataDir(profileId)
      if (!dir) {
        opts.log?.('warn', `deploy: percorso istanza non risolvibile per profilo ${profileId}`)
        return {
          success: false,
          errorKind: 'db',
          error: `profilo ${profileId} non trovato o percorso istanza non configurato`,
        }
      }
      return await deployInstance(opts.db, dir, {
        profileId,
        stockGameDataDir: opts.resolveStockGameDataDir?.(profileId) ?? undefined,
        systemPluginsDir: opts.resolveSystemPluginsDir?.() ?? undefined,
        masterlistPath: opts.resolveMasterlistPath?.() ?? undefined,
        lootMasterlistCachePath: opts.resolveLootMasterlistCachePath?.() ?? undefined,
        allowHeuristicCleanup: opts.allowHeuristics?.() ?? true,
        log: opts.log,
        onProgress,
      })
    } catch (e) {
      opts.log?.('warn', `deploy errore inatteso: ${(e as Error).message}`)
      return { success: false, errorKind: 'db', error: (e as Error).message }
    }
  }

  ipcMain.handle('deploy:run', async (event, profileId: number): Promise<DeployResult> =>
    // Stream progress back to the renderer that invoked us. Guard the send: the
    // window may have closed mid-deploy, and a throwing sender must not abort the deploy.
    runDeploy(profileId, (p) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send('deploy:progress', p)
      } catch {
        /* renderer gone — ignore */
      }
    }),
  )

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

  // ── ESL-ify (ESLIFY-01): libera slot FULL flaggando light i pure-override ──────────
  // Il flag light (bit 0x200 del TES4) è sicuro SENZA compattazione SOLO per i plugin a
  // zero record nuovi (vedi eslify.ts). scan = dry-run; apply scrive 4 byte per file con
  // backup `.smm-esl-bak` accanto alla sorgente (revert = ripristinare il backup).
  // NB: la sorgente in mods/ e l'eventuale copia deployata sono lo STESSO inode
  // (hardlink): la scrittura le aggiorna entrambe, coerenti per costruzione.
  const ESL_MAX_SCAN_BYTES = 150 * 1024 * 1024
  ipcMain.handle(
    'plugins:eslify',
    (
      _e,
      profileId: number,
      apply: boolean,
      margin = 6,
    ): {
      ok: boolean
      budget?: { full: number; light: number; maxFull: number }
      slotsToFree?: number
      eligible?: { name: string; size: number; totalRecords?: number }[]
      flagged?: { name: string; size: number }[]
      errors?: string[]
      error?: string
    } => {
      try {
        const preview = previewDeploy(opts.db, {
          profileId,
          stockGameDataDir: opts.resolveStockGameDataDir?.(profileId) ?? undefined,
          masterlistPath: opts.resolveMasterlistPath?.() ?? undefined,
          lootMasterlistCachePath: opts.resolveLootMasterlistCachePath?.() ?? undefined,
        })
        if (!preview.ok || !preview.pluginBudget)
          return { ok: false, error: preview.error ?? preview.loadOrderIssue ?? 'budget plugin non calcolabile' }
        const budget = preview.pluginBudget
        const slotsToFree = Math.max(0, budget.full - (budget.maxFull - Math.max(0, margin)))
        if (slotsToFree === 0)
          return { ok: true, budget, slotsToFree: 0, eligible: [], flagged: [] }

        const candidates: EslCandidate[] = []
        for (const p of planPluginFiles(opts.db, profileId)) {
          if (!p.name.toLowerCase().endsWith('.esp')) continue
          let size: number
          try {
            size = statSync(p.src).size
          } catch {
            continue
          }
          if (size > ESL_MAX_SCAN_BYTES) continue // mai leggere giganti in RAM: non candidato
          let cls: ReturnType<typeof classifyForEsl>
          try {
            cls = classifyForEsl(p.name, readFileSync(p.src))
          } catch {
            continue
          }
          if (cls.eligible)
            candidates.push({ name: p.name, src: p.src, size, eligible: true, reason: cls.reason, totalRecords: cls.totalRecords })
        }
        candidates.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name))
        const picked = pickToFlag(candidates, slotsToFree)

        if (!apply) {
          return {
            ok: true,
            budget,
            slotsToFree,
            eligible: candidates.map((c) => ({ name: c.name, size: c.size, totalRecords: c.totalRecords })),
            flagged: [],
          }
        }

        const flagged: { name: string; size: number }[] = []
        const errors: string[] = []
        for (const c of picked) {
          try {
            const bak = c.src + '.smm-esl-bak'
            if (!existsSync(bak)) copyFileSync(c.src, bak)
            const fd = openSync(c.src, 'r+')
            try {
              const cur = Buffer.alloc(4)
              readSync(fd, cur, 0, 4, TES4_FLAGS_OFFSET)
              writeSync(fd, lightFlagBytes(cur.readUInt32LE(0)), 0, 4, TES4_FLAGS_OFFSET)
            } finally {
              closeSync(fd)
            }
            flagged.push({ name: c.name, size: c.size })
            opts.log?.('info', `eslify: "${c.name}" flaggato light (backup ${c.name}.smm-esl-bak)`)
          } catch (e) {
            errors.push(`${c.name}: ${(e as Error).message}`)
            opts.log?.('warn', `eslify: flag di "${c.name}" fallito — ${(e as Error).message}`)
          }
        }
        return {
          ok: flagged.length > 0 || slotsToFree === 0,
          budget,
          slotsToFree,
          eligible: candidates.map((c) => ({ name: c.name, size: c.size, totalRecords: c.totalRecords })),
          flagged,
          errors: errors.length ? errors : undefined,
          error:
            flagged.length < slotsToFree
              ? `flaggati ${flagged.length}/${slotsToFree} richiesti: candidati pure-override insufficienti — disabilita manualmente alcune mod ESP`
              : undefined,
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )

  // Esposto al chiamante (main.ts) perché la riparazione automatica pre-avvio deployi
  // esattamente come il bottone Deploy, senza reimplementarne le opzioni.
  return { runDeploy }
}
