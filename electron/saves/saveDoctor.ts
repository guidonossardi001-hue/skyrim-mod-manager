import { join } from 'path'
import { parseEss, type EssInfo } from './essParser'

// "Save Doctor" (T16): diagnosi read-only dell'ULTIMO salvataggio contro il load order
// attivo. Il caso reale che intercetta: l'utente cambia modlist a metà playthrough →
// il save referenzia plugin che non esistono più → CTD al load o progressione corrotta,
// senza alcun indizio sul perché. Qui il mismatch emerge PRIMA del lancio, con nomi.
//
// Un plugin del save è "mancante" solo se non è né tra i plugin ABILITATI (plugins.txt
// di sistema) né presente come FILE nella Data del gioco (che copre vanilla + Creation
// Club, auto-caricati senza riga in plugins.txt). Fail-soft ovunque: qualunque IO o
// parse fallito → verdetto "non verificato", mai un warning inventato.

export interface SaveDoctorIo {
  exists: (p: string) => boolean
  listDir: (p: string) => { name: string; mtimeMs: number }[]
  readFileBuf: (p: string) => Buffer
  readFileText: (p: string) => string
}

export interface SaveDoctorReport {
  /** false = nessun save trovato o non parsabile: niente diagnosi (mai warning spurio). */
  checked: boolean
  saveName: string | null
  playerName: string | null
  playerLevel: number | null
  playerLocation: string | null
  /** Plugin richiesti dal save assenti dal load order attivo (campione, max 10). */
  missingPlugins: string[]
  missingCount: number
  totalSavePlugins: number
}

const NOT_CHECKED: SaveDoctorReport = {
  checked: false,
  saveName: null,
  playerName: null,
  playerLevel: null,
  playerLocation: null,
  missingPlugins: [],
  missingCount: 0,
  totalSavePlugins: 0,
}

const SAMPLE_CAP = 10

/** Il .ess più recente nella cartella saves; null se assente/vuota. */
export function findLatestSave(savesDir: string, io: SaveDoctorIo): string | null {
  try {
    if (!io.exists(savesDir)) return null
    const saves = io
      .listDir(savesDir)
      .filter((e) => e.name.toLowerCase().endsWith('.ess'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return saves.length ? join(savesDir, saves[0].name) : null
  } catch {
    return null
  }
}

/** Plugin ABILITATI dal plugins.txt di sistema (righe `*Nome.esp`); [] se illeggibile. */
export function readEnabledPlugins(pluginsTxtPath: string | null, io: SaveDoctorIo): string[] {
  if (!pluginsTxtPath) return []
  try {
    if (!io.exists(pluginsTxtPath)) return []
    return io
      .readFileText(pluginsTxtPath)
      .split(/\r?\n/)
      .filter((l) => l.startsWith('*'))
      .map((l) => l.slice(1).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Diff puro: plugin del save non coperti né dagli abilitati né dai file su disco. */
export function diagnoseSave(
  ess: EssInfo,
  enabledPlugins: string[],
  dataDirFiles: string[],
): { missing: string[]; missingCount: number } {
  const available = new Set<string>()
  for (const p of enabledPlugins) available.add(p.toLowerCase())
  for (const f of dataDirFiles) available.add(f.toLowerCase())
  const missing: string[] = []
  let missingCount = 0
  for (const p of [...ess.plugins, ...ess.lightPlugins]) {
    if (!available.has(p.toLowerCase())) {
      missingCount++
      if (missing.length < SAMPLE_CAP) missing.push(p)
    }
  }
  return { missing, missingCount }
}

export interface SaveDoctorEnv {
  savesDir: string
  /** plugins.txt DI SISTEMA (%LOCALAPPDATA%/Skyrim Special Edition) — quello letto dal gioco. */
  systemPluginsTxt: string | null
  /** Data del gioco: la presenza file copre vanilla + Creation Club auto-caricati. */
  gameDataDir: string | null
}

export function runSaveDoctor(env: SaveDoctorEnv, io: SaveDoctorIo): SaveDoctorReport {
  try {
    const savePath = findLatestSave(env.savesDir, io)
    if (!savePath) return NOT_CHECKED
    const ess = parseEss(io.readFileBuf(savePath))
    if (!ess) return NOT_CHECKED

    const enabled = readEnabledPlugins(env.systemPluginsTxt, io)
    let dataFiles: string[] = []
    try {
      if (env.gameDataDir && io.exists(env.gameDataDir)) {
        dataFiles = io
          .listDir(env.gameDataDir)
          .map((e) => e.name)
          .filter((n) => /\.(esm|esp|esl)$/i.test(n))
      }
    } catch {
      dataFiles = []
    }
    // Senza NESSUNA fonte di verità sul load order la diff direbbe "manca tutto":
    // meglio dichiarare non-verificato che allarmare a vuoto.
    if (enabled.length === 0 && dataFiles.length === 0) return NOT_CHECKED

    const { missing, missingCount } = diagnoseSave(ess, enabled, dataFiles)
    const saveName = savePath.split(/[\\/]/).pop() ?? savePath
    return {
      checked: true,
      saveName,
      playerName: ess.playerName,
      playerLevel: ess.playerLevel,
      playerLocation: ess.playerLocation,
      missingPlugins: missing,
      missingCount,
      totalSavePlugins: ess.plugins.length + ess.lightPlugins.length,
    }
  } catch {
    return NOT_CHECKED
  }
}
