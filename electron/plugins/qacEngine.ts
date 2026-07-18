// Quick Auto Clean headless — parte IO/spawn (T20). Nessun contratto di exit-code documentato
// per xEdit (verificato): il watchdog esterno è OBBLIGATORIO — xEdit può restare bloccato su un
// dialog modale (master mancante, plugin corrotto) senza mai uscire da solo. Pattern ricalcato
// su PACT (github.com/GuidanceOfGrace/XEdit-PACT): cancella i log preesistenti prima del run,
// spawn con timeout, attende ~1s dopo l'uscita per il flush I/O, poi legge i log.

import { spawn } from 'child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { BASE_MASTERS } from '../deploy/plan'
import { buildQacArgs, isProtectedMaster, qacLogFileNames, classifyQacRun, type QacResult } from './qacRunner'
import { startDialogWatcher, type DialogWatcherHandle, type WatcherEvent } from './dialogWatcher'

/** plugins.txt minimale: i master di base + SOLO il plugin target, tutti attivi ('*'). Mai il profilo reale dell'utente. */
function writeTempPluginsTxt(dir: string, pluginName: string): string {
  const path = join(dir, 'plugins.txt')
  const lines = [...BASE_MASTERS, pluginName].map((n) => `*${n}`)
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return path
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* assente: nulla da fare */
  }
}

function safeReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface RunQacOptions {
  xeditPath: string
  dataPath: string
  pluginName: string
  gameFlag?: string // default 'SSE'
  timeoutMs?: number // default 180000 (3 min) — un singolo plugin non richiede il default PACT di 300s
  postExitFlushMs?: number // default 1000, per dare tempo a xEdit di scrivere il log su disco
  /** Iniettabile nei test: stessa firma di child_process.spawn. Default: spawn reale. */
  spawnImpl?: typeof spawn
  /** false = disattiva il watcher dei dialog bloccanti xEdit (default: attivo). Mai disattivarlo
   *  in produzione: esiste proprio perché xEdit non è realmente headless (vedi dialogWatcher.ts). */
  dialogWatcherEnabled?: boolean
  /** Iniettabile nei test: stessa firma di startDialogWatcher. Default: watcher reale. */
  dialogWatcherImpl?: typeof startDialogWatcher
  onDialogEvent?: (ev: WatcherEvent) => void
}

/**
 * Esegue Quick Auto Clean headless su UN plugin. Precondizione responsabilità del chiamante:
 * il gioco e MO2 devono essere chiusi (raccomandazione esplicita della community — xEdit non
 * deve girare insieme a un'istanza del gioco/VFS attiva sullo stesso Data).
 */
export async function runQuickAutoClean(opts: RunQacOptions): Promise<QacResult> {
  if (isProtectedMaster(opts.pluginName)) {
    return { verdict: 'blocked', summary: `"${opts.pluginName}" è un master ufficiale del gioco: non va mai pulito`, log: null }
  }
  if (!existsSync(opts.xeditPath)) {
    return { verdict: 'launch-failed', summary: `xEdit non trovato: ${opts.xeditPath}`, log: null }
  }

  const gameFlag = opts.gameFlag ?? 'SSE'
  const timeoutMs = opts.timeoutMs ?? 180_000
  const postExitFlushMs = opts.postExitFlushMs ?? 1000
  const exeDir = dirname(opts.xeditPath)
  const { log: logName, exception: exceptionName } = qacLogFileNames(gameFlag)
  const logPath = join(exeDir, logName)
  const exceptionPath = join(exeDir, exceptionName)

  // Log stantii dalla corsa precedente falsificherebbero l'esito di questa.
  safeUnlink(logPath)
  safeUnlink(exceptionPath)

  const tmpDir = mkdtempSync(join(tmpdir(), 'smm-qac-'))
  let timedOut = false
  try {
    const pluginsTxtPath = writeTempPluginsTxt(tmpDir, opts.pluginName)
    const args = buildQacArgs({ gameFlag, dataPath: opts.dataPath, pluginsTxtPath, pluginName: opts.pluginName })

    const exitPromise = new Promise<void>((resolve) => {
      const doSpawn = opts.spawnImpl ?? spawn
      const child = doSpawn(opts.xeditPath, args, { cwd: exeDir, windowsHide: true, stdio: 'ignore' })
      const watchdog = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      // Watcher dei dialog bloccanti xEdit (avviso 64bit, promemoria donazioni — vedi
      // dialogWatcher.ts per la ricerca che ne motiva l'esistenza). Coperto dallo stesso
      // timeout del run: se il watcher non basta, il watchdog sopra interviene comunque.
      let dialogWatcher: DialogWatcherHandle | undefined
      if (opts.dialogWatcherEnabled !== false && child.pid) {
        const doStartWatcher = opts.dialogWatcherImpl ?? startDialogWatcher
        dialogWatcher = doStartWatcher(child.pid, { maxDurationMs: timeoutMs, onEvent: opts.onDialogEvent })
      }
      child.on('error', () => {
        clearTimeout(watchdog)
        dialogWatcher?.stop()
        resolve()
      })
      child.on('exit', () => {
        clearTimeout(watchdog)
        dialogWatcher?.stop()
        resolve()
      })
    })
    await exitPromise
    await sleep(postExitFlushMs)

    return classifyQacRun({
      logText: safeReadFile(logPath),
      exceptionLogExists: existsSync(exceptionPath),
      timedOut,
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
