import { ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'
import type { SqliteDb } from '../db/sqlite'
import { tryAcquireBusyGate, releaseBusyGate, currentBusyLabel } from '../util/busyGate'
import {
  scanBodySlideAssets,
  planBuildPasses,
  presetCoverage,
  chunkGroups,
  buildBodySlideArgs,
  renderBodySlideConfig,
  checkPhysicsPrereqs,
  BODYSLIDE_DIR_REL,
  BODYSLIDE_OUTPUT_MOD_NAME,
  BODYSLIDE_OUTPUT_DIR,
  BODYSLIDE_OUTPUT_WEIGHT,
  type BsFs,
  type PhysicsPrereqs,
} from './bodyslide'

// IPC del flusso BodySlide (BODYSLIDE-01): status read-only + batch build headless.
// Stesso pattern degli altri *engine.ts: dipendenze iniettate, handler no-throw.
//
// Il build usa l'exe DEPLOYATO nella Data del gioco (è lì che il deploy fonde i
// progetti di tutte le mod) ma scrive in una cartella-mod dedicata (--targetdir):
// mai in-place dentro Data, dove ogni file è un hardlink alla sorgente della mod.

export interface BodySlideStatus {
  ok: boolean
  exeFound: boolean
  exePath?: string
  /** Deploy attivo sulla Data (manifest presente): senza, i progetti non sono fusi. */
  deployed: boolean
  groupCount: number
  setsCount: number
  presets: { name: string; set: string; coverage: number }[]
  defaultPreset: string | null
  prereqs: PhysicsPrereqs
  outputRegistered: boolean
  error?: string
}

export interface BodySlideBuildResult {
  ok: boolean
  passes: { label: string; preset: string; groups: number; chunks: number; failedChunks: number }[]
  filesBuilt: number
  outputDir?: string
  modRegistered: boolean
  error?: string
}

export interface BodySlideEngineOptions {
  db: SqliteDb
  resolveGameDataDir: () => string | null
  resolveModsRoot: () => string
  /** Spawn del builder, iniettato (il main usa child_process). Risolve sempre, mai throw. */
  runExe: (exe: string, args: string[], cwd: string) => Promise<{ code: number | null; error?: string }>
  onProgress?: (p: { pass: number; passes: number; chunk: number; chunks: number; label: string }) => void
  log?: (level: 'info' | 'warn', msg: string) => void
}

const realBsFs: BsFs = {
  exists: existsSync,
  readdir: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  },
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf-8')
    } catch {
      return null
    }
  },
}

/**
 * Conta SOLO i file toccati da QUESTO run (mtime ≥ sinceMs, con 2s di tolleranza per skew
 * filesystem). BUG REALE: outputDir non viene mai svuotata tra un build e l'altro (build
 * incrementali per preset diversi devono convivere) — countFilesRec sul totale falsava
 * filesBuilt/anyBuilt/modRegistered con gli avanzi di run PRECEDENTI: un run che non produce
 * nulla di nuovo (tutti i chunk falliti) risultava comunque "riuscito" se la cartella aveva
 * già contenuto da prima. Mai svuotare outputDir prima del run: un fallimento a metà non deve
 * MAI regredire una mod già registrata e funzionante nel gioco a una cartella vuota.
 */
function countFreshFilesRec(root: string, sinceMs: number): number {
  try {
    let n = 0
    for (const d of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!d.isFile()) continue
      try {
        const abs = join(d.parentPath, d.name)
        if (statSync(abs).mtimeMs >= sinceMs - 2000) n++
      } catch {
        /* file svanito tra readdir e stat: non contarlo */
      }
    }
    return n
  } catch {
    return 0
  }
}

export function initBodySlideEngine(opts: BodySlideEngineOptions) {
  const enabledModNames = (): string[] => {
    try {
      return (
        opts.db.prepare('SELECT name FROM mods WHERE is_enabled=1 AND is_installed=1').all() as { name: string }[]
      ).map((r) => r.name)
    } catch {
      return []
    }
  }

  const outputRegistered = (): boolean => {
    try {
      return !!opts.db.prepare('SELECT id FROM mods WHERE name=?').get(BODYSLIDE_OUTPUT_MOD_NAME)
    } catch {
      return false
    }
  }

  ipcMain.handle('bodyslide:status', (): BodySlideStatus => {
    const empty: Omit<BodySlideStatus, 'ok' | 'error'> = {
      exeFound: false,
      deployed: false,
      groupCount: 0,
      setsCount: 0,
      presets: [],
      defaultPreset: null,
      prereqs: { body: false, cbpc: false, fsmp: false, skeleton: false },
      outputRegistered: false,
    }
    try {
      const dataDir = opts.resolveGameDataDir()
      if (!dataDir) return { ok: false, ...empty, error: 'percorso del gioco non configurato' }
      const assets = scanBodySlideAssets(dataDir, realBsFs)
      const plan = planBuildPasses(assets)
      return {
        ok: true,
        exeFound: !!assets.exePath,
        exePath: assets.exePath ?? undefined,
        deployed: existsSync(join(dataDir, '.smm-deploy-manifest.json')),
        groupCount: assets.groups.length,
        setsCount: assets.setsCount,
        presets: assets.presets
          .map((p) => ({ name: p.name, set: p.set, coverage: presetCoverage(p, assets.groups) }))
          .sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name)),
        defaultPreset: plan.passes[0]?.preset ?? null,
        prereqs: checkPhysicsPrereqs(enabledModNames()),
        outputRegistered: outputRegistered(),
      }
    } catch (e) {
      return { ok: false, ...empty, error: (e as Error).message }
    }
  })

  // Il renderer passa solo profileId e NOME preset (validato contro i preset scansionati
  // dentro planBuildPasses: nome sconosciuto → default). Nessun path attraversa l'IPC.
  ipcMain.handle('bodyslide:build', async (_e, profileId: number, presetName?: string): Promise<BodySlideBuildResult> => {
    const fail = (error: string): BodySlideBuildResult => ({
      ok: false,
      passes: [],
      filesBuilt: 0,
      modRegistered: false,
      error,
    })
    // Serializzazione con deploy/FOMOD/ESL-ify: BodySlide legge/scrive sotto Data e modsRoot,
    // un deploy concorrente vedrebbe uno stato a metà.
    if (!tryAcquireBusyGate('bodyslide')) {
      return fail(`Un'altra operazione pesante (${currentBusyLabel()}) è già in corso: attendi che finisca.`)
    }
    try {
      const dataDir = opts.resolveGameDataDir()
      if (!dataDir) return fail('percorso del gioco non configurato')
      const assets = scanBodySlideAssets(dataDir, realBsFs)
      if (!assets.exePath) return fail('BodySlide.exe non trovato nella Data del gioco: esegui prima il Deploy')
      // Gate identità al sink dello spawn, come TOOL_BINARIES: mai un exe inatteso.
      if (!/^bodyslide\.exe$/i.test(basename(assets.exePath))) return fail('eseguibile BodySlide non riconosciuto')
      const plan = planBuildPasses(assets, typeof presetName === 'string' ? presetName : undefined)
      if (plan.error || !plan.passes.length) return fail(plan.error ?? 'nessun pass di build pianificabile')

      // Config.xml come FILE REALE (rompe l'hardlink del deploy): BodySlide riscrive la
      // config all'uscita e non deve toccare la copia sorgente della mod.
      const configPath = join(dataDir, BODYSLIDE_DIR_REL, 'Config.xml')
      try {
        rmSync(configPath, { force: true })
      } catch {
        /* sovrascritta sotto */
      }
      writeFileSync(configPath, renderBodySlideConfig(dataDir), 'utf-8')

      const outputDir = join(opts.resolveModsRoot(), BODYSLIDE_OUTPUT_DIR)
      mkdirSync(outputDir, { recursive: true })
      // Mai svuotata: build incrementali per preset diversi convivono nella stessa cartella.
      // filesBuilt conta SOLO i file toccati DA QUESTO run (vedi countFreshFilesRec).
      const buildStartMs = Date.now()

      const results: BodySlideBuildResult['passes'] = []
      for (let pi = 0; pi < plan.passes.length; pi++) {
        const pass = plan.passes[pi]
        const chunks = chunkGroups(pass.groups)
        let failedChunks = 0
        for (let ci = 0; ci < chunks.length; ci++) {
          opts.onProgress?.({ pass: pi + 1, passes: plan.passes.length, chunk: ci + 1, chunks: chunks.length, label: pass.label })
          opts.log?.(
            'info',
            `build "${pass.label}" preset "${pass.preset}" — chunk ${ci + 1}/${chunks.length} (${chunks[ci].length} gruppi) → ${outputDir}`,
          )
          const r = await opts.runExe(assets.exePath, buildBodySlideArgs(pass.preset, chunks[ci], outputDir), dirname(assets.exePath))
          if (r.code !== 0) {
            failedChunks++
            opts.log?.('warn', `chunk ${ci + 1}/${chunks.length} di "${pass.label}" fallito: ${r.error ?? `exit code ${r.code}`}`)
          }
        }
        results.push({ label: pass.label, preset: pass.preset, groups: pass.groups.length, chunks: chunks.length, failedChunks })
      }

      const filesBuilt = countFreshFilesRec(outputDir, buildStartMs)
      const anyBuilt = filesBuilt > 0
      let modRegistered = false
      if (anyBuilt) {
        // Registra l'output come mod del profilo: 'patch' + peso altissimo → i mesh
        // generati vincono ogni conflitto al prossimo Deploy (equivalente MO2 "output mod").
        const existing = opts.db
          .prepare('SELECT id FROM mods WHERE profile_id=? AND name=?')
          .get(profileId, BODYSLIDE_OUTPUT_MOD_NAME) as { id: number } | undefined
        if (existing) {
          opts.db
            .prepare('UPDATE mods SET install_path=?, is_enabled=1, is_installed=1, deploy_category=?, resolution_weight=? WHERE id=?')
            .run(outputDir, 'patch', BODYSLIDE_OUTPUT_WEIGHT, existing.id)
        } else {
          const maxPrio = (opts.db.prepare('SELECT MAX(priority) mp FROM mods WHERE profile_id=?').get(profileId) as { mp: number | null })
            .mp
          opts.db
            .prepare(
              `INSERT INTO mods (profile_id, name, category, install_path, is_enabled, is_installed, priority, deploy_category, resolution_weight)
               VALUES (?,?,?,?,1,1,?,?,?)`,
            )
            .run(profileId, BODYSLIDE_OUTPUT_MOD_NAME, 'Generated', outputDir, (maxPrio ?? 0) + 1, 'patch', BODYSLIDE_OUTPUT_WEIGHT)
        }
        modRegistered = true
      }

      const totalFailed = results.reduce((s, r) => s + r.failedChunks, 0)
      opts.log?.(
        totalFailed ? 'warn' : 'info',
        `batch build completato: ${filesBuilt} file in ${outputDir} · ${results.length} pass · ${totalFailed} chunk falliti`,
      )
      return {
        ok: anyBuilt && totalFailed === 0,
        passes: results,
        filesBuilt,
        outputDir,
        modRegistered,
        error: anyBuilt
          ? totalFailed
            ? `${totalFailed} chunk falliti (vedi log) — output parziale registrato`
            : undefined
          : 'nessun file generato (vedi log BodySlide nella cartella CalienteTools/BodySlide)',
      }
    } catch (e) {
      return fail((e as Error).message)
    } finally {
      releaseBusyGate()
    }
  })
}
