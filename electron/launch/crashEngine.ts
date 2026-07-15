import { ipcMain, app } from 'electron'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { parseCrashLog, analyzeCrashLog, type CrashLogReport, type CrashAnalysis } from './crashLogAnalyzer'

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
        const analysis = analyzeCrashLog(report)
        // Un estratto grezzo (prime righe) resta sempre disponibile: l'euristica è piccola e
        // onesta, non pretende di coprire ogni caso — l'utente deve poter leggere l'originale.
        return { ok: true, report, analysis, rawExcerpt: text.split(/\r?\n/).slice(0, 40).join('\n') }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )
}
