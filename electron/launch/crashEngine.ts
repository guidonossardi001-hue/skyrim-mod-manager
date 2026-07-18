import { ipcMain, app } from 'electron'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { parseCrashLog, analyzeCrashLog, type CrashLogReport, type CrashAnalysis } from './crashLogAnalyzer'

// Path assoluto System32 (stessa difesa binary-planting di steam/detect.ts).
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const TASKLIST_EXE = join(SYS32, 'tasklist.exe')

/** true se SkyrimSE.exe risulta in esecuzione (probe leggera, mai throw). */
export function isGameRunning(): boolean {
  try {
    const out = execFileSync(TASKLIST_EXE, ['/FI', 'IMAGENAME eq SkyrimSE.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    return /skyrimse\.exe/i.test(out)
  } catch {
    return false
  }
}

// Thin ipcMain wrapper (stesso pattern degli altri *engine.ts): crash:list-recent enumera i log
// nella cartella standard SKSE (sola lettura), crash:analyze legge+parse+analizza un file dato
// (percorso arbitrario dal renderer: già passato da fs:pick-file o dalla lista sopra, mai un
// input libero digitato — coerente col resto dell'app).

export const DEFAULT_CRASH_LOG_DIR = () =>
  join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition', 'SKSE')

export interface CrashLogEntry {
  name: string
  path: string
  mtimeMs: number
  size: number
}

function listCrashLogs(dir: string, cap: number): CrashLogEntry[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => /^crash-.*\.log$/i.test(f))
      .map((f) => {
        const p = join(dir, f)
        const st = statSync(p)
        return { name: f, path: p, mtimeMs: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, cap)
  } catch {
    return []
  }
}

// ── Auto-analisi post-lancio ─────────────────────────────────────────────────
// Il gioco parte DETACHED (sopravvive alla chiusura del launcher): non c'è un exit
// code da osservare. Rilevamento crash = polling leggero della cartella SKSE per un
// crash-*.log NUOVO (mtime > istante di lancio). Un solo watch alla volta; si spegne
// al primo match o al timeout. Fail-soft totale: un errore di lettura non deve mai
// disturbare né il lancio né la chiusura dell'app.
let crashWatchTimer: NodeJS.Timeout | null = null

export interface CrashWatchOptions {
  sinceMs: number // istante del lancio: contano solo log più recenti
  onFound: (payload: {
    file: string
    report: CrashLogReport
    analysis: CrashAnalysis
    /** true = SkyrimSE.exe risulta ANCORA vivo: crash CONTINUABLE, processo zombie da chiudere. */
    gameStillRunning: boolean
  }) => void
  intervalMs?: number // default 30s — I/O trascurabile (readdir di una cartella piccola)
  timeoutMs?: number // default 3h — oltre, la sessione di gioco non è più "questo lancio"
  dir?: string // iniettabile nei/test; default cartella SKSE standard
  /** Probe processo iniettabile nei test; default isGameRunning (tasklist). */
  gameRunningProbe?: () => boolean
}

export function stopCrashWatch(): void {
  if (crashWatchTimer) {
    clearInterval(crashWatchTimer)
    crashWatchTimer = null
  }
}

export function armCrashWatch(opts: CrashWatchOptions): void {
  stopCrashWatch() // un nuovo lancio sostituisce il watch precedente
  const dir = opts.dir ?? DEFAULT_CRASH_LOG_DIR()
  const interval = opts.intervalMs ?? 30_000
  const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60 * 60 * 1000)
  crashWatchTimer = setInterval(() => {
    try {
      if (Date.now() > deadline) {
        stopCrashWatch()
        return
      }
      const fresh = listCrashLogs(dir, 5).find((e) => e.mtimeMs > opts.sinceMs)
      if (!fresh) return
      // Il timer si ferma SOLO dopo lettura+parse riusciti: il crash logger può tenere
      // il file lockato/in scrittura proprio in questa finestra (caso reale: crash
      // CONTINUABLE col processo zombie vivo) — fermarlo prima uccideva il watch in
      // silenzio alla prima readFileSync fallita e il crash non veniva MAI notificato.
      const text = readFileSync(fresh.path, 'utf8')
      const report = parseCrashLog(text)
      stopCrashWatch()
      const gameStillRunning = (opts.gameRunningProbe ?? isGameRunning)()
      opts.onFound({ file: fresh.path, report, analysis: analyzeCrashLog(report, text), gameStillRunning })
    } catch {
      /* cartella assente/log illeggibile o lockato: il timer è VIVO, si riprova davvero */
    }
  }, interval)
  // Il watch non deve tenere vivo il processo alla chiusura dell'app.
  crashWatchTimer.unref?.()
}

/**
 * Scansione one-shot di RECUPERO (da chiamare all'avvio dell'app): il watch post-lancio
 * muore col processo launcher mentre il gioco è detached — un crash avvenuto dopo la
 * chiusura del launcher non veniva MAI segnalato. Qui: log più recente di `sinceMs` e
 * diverso da `alreadyNotifiedPath` → stesso payload del watch. null = niente di nuovo.
 */
export function findMissedCrash(
  sinceMs: number,
  alreadyNotifiedPath?: string | null,
  dir?: string,
): { file: string; report: CrashLogReport; analysis: CrashAnalysis } | null {
  try {
    const fresh = listCrashLogs(dir ?? DEFAULT_CRASH_LOG_DIR(), 5).find(
      (e) => e.mtimeMs > sinceMs && e.path !== (alreadyNotifiedPath ?? ''),
    )
    if (!fresh) return null
    const text = readFileSync(fresh.path, 'utf8')
    const report = parseCrashLog(text)
    return { file: fresh.path, report, analysis: analyzeCrashLog(report, text) }
  } catch {
    return null
  }
}

export function initCrashEngine() {
  ipcMain.handle('crash:list-recent', () => {
    try {
      return { ok: true as const, dir: DEFAULT_CRASH_LOG_DIR(), entries: listCrashLogs(DEFAULT_CRASH_LOG_DIR(), 20) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'crash:analyze',
    (
      _e,
      filePath: string,
    ): { ok: boolean; report?: CrashLogReport; analysis?: CrashAnalysis; rawExcerpt?: string; error?: string } => {
      try {
        const text = readFileSync(filePath, 'utf8')
        const report = parseCrashLog(text)
        const analysis = analyzeCrashLog(report, text)
        // Un estratto grezzo (prime righe) resta sempre disponibile: l'euristica è piccola e
        // onesta, non pretende di coprire ogni caso — l'utente deve poter leggere l'originale.
        return { ok: true, report, analysis, rawExcerpt: text.split(/\r?\n/).slice(0, 40).join('\n') }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )
}
