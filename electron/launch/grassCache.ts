// Grass cache "autopilota" (T19) — parte pura: parsing dei nomi file .cgid, calcolo dei
// prerequisiti INI, riepilogo di copertura per worldspace.
//
// Fatti verificati (ricerca GitHub/web dedicata, 2026-07-18): generare il CONTENUTO della
// grass cache richiede INEVITABILMENTE Skyrim (con SKSE + NGIO/"No Grass In Objects") in
// esecuzione reale — 25min-2,5h, con crash attesi durante il processo (fonti: NGIO/GrassControl
// su GitHub, Nexus articles 6919/6920, guida Nolvus). Nessun tool headless/offline esiste allo
// stato dell'arte. Questo modulo NON pretende di generare la cache senza il gioco: si limita a
// (1) verificare i prerequisiti ini, (2) analizzare la copertura della cache già presente sul
// disco. La supervisione del processo di gioco (lancio/crash/rilancio) vive in grassCacheEngine.ts
// (thin, IO — pattern identico a crashEngine.ts), ricalcata sul comportamento REALE di
// Al12rs/modorganizer-GrassPrecacher (l'unico automatismo noto: spawn, attesa uscita, rilancio
// se il marker file esiste ancora — mai generazione "vera" fuori dal processo di gioco).

export const PRECACHE_MARKER_FILENAME = 'PrecacheGrass.txt'

export interface GrassCacheEntry {
  fileName: string
  worldspace: string
  x: number
  y: number
  season: 'SPR' | 'SUM' | 'AUT' | 'WIN' | null
}

// "<Worldspace>x<X 4-cifre-con-segno>y<Y 4-cifre-con-segno>[.SPR|.SUM|.AUT|.WIN].cgid"
// es. "Tamrielx-0047y0038.cgid", "Tamrielx-0047y0038.WIN.cgid" (varianti stagionali).
const CGID_RE = /^(.+?)x(-?\d{4})y(-?\d{4})(?:\.(SPR|SUM|AUT|WIN))?\.cgid$/i

/** Parsa un nome file .cgid. null = non combacia col formato noto (non è un errore: si ignora). */
export function parseGrassCacheFilename(fileName: string): GrassCacheEntry | null {
  const m = fileName.match(CGID_RE)
  if (!m) return null
  return {
    fileName,
    worldspace: m[1],
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    season: (m[4]?.toUpperCase() as GrassCacheEntry['season']) ?? null,
  }
}

export interface GrassCacheSummary {
  totalFiles: number
  parsedCount: number
  unparsedCount: number
  byWorldspace: Record<string, number>
}

/** Riepiloga una lista di nomi file grezzi in conteggi per worldspace. Puro, nessuna I/O. */
export function summarizeGrassCache(fileNames: string[]): GrassCacheSummary {
  const byWorldspace: Record<string, number> = {}
  let parsedCount = 0
  for (const f of fileNames) {
    const e = parseGrassCacheFilename(f)
    if (!e) continue
    parsedCount++
    byWorldspace[e.worldspace] = (byWorldspace[e.worldspace] ?? 0) + 1
  }
  return { totalFiles: fileNames.length, parsedCount, unparsedCount: fileNames.length - parsedCount, byWorldspace }
}

/** Legge una singola chiave da un blob ini grezzo (sola lettura — non è l'editor di iniService). */
export function readIniValue(text: string, section: string, key: string): string | null {
  const secRe = new RegExp(`^\\s*\\[${section}\\]\\s*$`, 'im')
  const secMatch = secRe.exec(text)
  if (!secMatch) return null
  const rest = text.slice(secMatch.index + secMatch[0].length)
  const nextSection = rest.search(/^\s*\[/m)
  const body = nextSection >= 0 ? rest.slice(0, nextSection) : rest
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'im')
  const keyMatch = keyRe.exec(body)
  if (!keyMatch) return null
  return keyMatch[1].trim().replace(/\s*[;#].*$/, '')
}

export interface GrassPrereqStatus {
  ready: boolean
  issues: string[]
  bAllowLoadGrass: boolean | null
  bGenerateGrassDataFiles: boolean | null
  markerPresent: boolean
}

/**
 * Verifica i prerequisiti ini per una sessione di precache. `bGenerateGrassDataFiles=1` va
 * impostato SOLO durante la generazione (poi va rimesso a 0 per il gioco normale, altrimenti
 * il motore continua a scrivere/validare la cache a ogni sessione) — questo modulo si limita a
 * riportare lo stato attuale, il toggle è responsabilità del chiamante (grassCacheEngine).
 */
export function checkGrassPrereqs(skyrimIniText: string, markerPresent: boolean): GrassPrereqStatus {
  const rawAllowLoad = readIniValue(skyrimIniText, 'Grass', 'bAllowLoadGrass')
  const rawGenerate = readIniValue(skyrimIniText, 'Grass', 'bGenerateGrassDataFiles')
  const bAllowLoadGrass = rawAllowLoad === null ? null : rawAllowLoad === '1'
  const bGenerateGrassDataFiles = rawGenerate === null ? null : rawGenerate === '1'

  const issues: string[] = []
  if (bAllowLoadGrass === false) issues.push('bAllowLoadGrass=0 in Skyrim.ini [Grass]: la cache generata non verrebbe mai caricata')
  if (!markerPresent) issues.push(`file marcatore "${PRECACHE_MARKER_FILENAME}" assente nella cartella del gioco: il precache non partirebbe al prossimo avvio`)

  return { ready: issues.length === 0, issues, bAllowLoadGrass, bGenerateGrassDataFiles, markerPresent }
}
