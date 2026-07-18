import { join } from 'path'

// xLODGen (sheson) — tool xEdit per generare terrain LOD (e object/tree LOD) partendo dal
// load order reale. NON è headless: l'utente sceglie worldspace + risoluzioni LOD nella GUI e
// preme Generate. Il nostro compito è LANCIARLO GIÀ PUNTATO alla collezione, così vede la Data
// deployata (mesh/texture delle mod) e il plugins.txt reale, e scrive in una cartella-mod
// ISOLATA che vince i conflitti al Deploy successivo — mai in-place dentro Data (dove ogni file
// è un hardlink alla sorgente della mod), mai nella cartella del gioco (default pericoloso di
// xLODGen, che rischia di sovrascrivere file esistenti).
//
// PURO: nessun IO qui — solo costanti e costruzione argomenti. Unit-testabile.

/** Riga mods + cartella output: la "mod generata" col terrain LOD costruito. */
export const XLODGEN_OUTPUT_MOD_NAME = 'xLODGen Output (generato)'
export const XLODGEN_OUTPUT_DIR = 'xlodgen-output'
/** Peso conflitti: il LOD generato DEVE vincere su ogni mesh/texture LOD deployato. */
export const XLODGEN_OUTPUT_WEIGHT = 1_000_000

export interface XLODGenArgsInput {
  /** Cartella output (mod isolata). Obbligatoria: senza, xLODGen scrive nel gioco. */
  outputDir: string
  /** Data deployata della collezione (game/Data o istanza). null = non passare -d. */
  dataDir?: string | null
  /** plugins.txt di sistema (%LOCALAPPDATA%), il load order reale. null = non passare -p. */
  pluginsTxt?: string | null
  /** Cartella INI (Documents/My Games/Skyrim Special Edition). null = non passare -m. */
  iniDir?: string | null
}

/**
 * Argomenti CLI per xLODGenx64.exe puntato alla collezione. `-sse` seleziona il game mode
 * (l'exe si chiama xLODGenx64.exe, non SSELODGenx64.exe, quindi il flag è OBBLIGATORIO: senza,
 * xLODGen non sa quale gioco caricare). `-o:` reindirizza l'output fuori dal gioco. `-d/-p/-m`
 * puntano rispettivamente Data / plugins.txt / cartella INI della collezione; omessi se null
 * (xLODGen ricade sui default del gioco rilevato — mai un arg vuoto che romperebbe il parsing).
 */
export function buildXLODGenArgs(input: XLODGenArgsInput): string[] {
  const args = ['-sse', `-o:${input.outputDir}`]
  if (input.dataDir) args.push(`-d:${input.dataDir}`)
  if (input.pluginsTxt) args.push(`-p:${input.pluginsTxt}`)
  if (input.iniDir) args.push(`-m:${input.iniDir}`)
  return args
}

/** Percorso assoluto della cartella-output sotto la radice mods gestita. */
export function xlodgenOutputDir(modsRoot: string): string {
  return join(modsRoot, XLODGEN_OUTPUT_DIR)
}
