// Servizio di configurazione di SSE Engine Fixes — il plugin SKSE più critico della collection
// (allocatore memoria + preloader Part 2 in root, fix del motore). Tre responsabilità:
//
//   1. VALIDAZIONE VERSIONE (pre-deploy): la EngineFixes.dll che il deploy sta per collegare è
//      compatibile col runtime dell'exe di Skyrim? Riusa il preflight statico SKSE
//      (classifySkseDll legge la struct SKSEPlugin_Version.compatibleVersions, ESATTAMENTE ciò
//      che SKSE stesso valuta al load). Verdetto 'incompatible' → il deploy si ferma.
//      Nasce da un incidente reale: una EngineFixes.dll SE (1.5.97) collegata su un gioco AE
//      1.6.1170 → "couldn't load plugin (000011C7)" e po3_Tweaks/FLM a cascata rotti.
//
//   2. INIEZIONE CONFIG (post-deploy): forza in EngineFixes.toml i parametri critici
//      (MaxStdio, MemoryManager) PRESERVANDO tutto il resto — commenti, altre chiavi, ordine —
//      via l'editor struttura-preservante di iniService col dialetto TOML.
//
//   3. LOCKDOWN: elenca i file Engine Fixes (Part 1 in Data/SKSE/Plugins + Part 2 in root) da
//      marcare read-only, così nessun processo li sovrascrive durante il runtime del launcher.
//
// Le funzioni PURE (apply/classify/lista file) non toccano il disco: testabili in isolamento.
// I wrapper *File usano fs reale e non lanciano mai (fail-soft: il deploy non deve fallire per
// un hiccup di lockdown/config, salvo l'incompatibilità di versione che è un blocco voluto).

import { readFileSync, chmodSync, statSync } from 'fs'
import { join } from 'path'
import { atomicWriteFile } from '../backup/snapshot'
import { toLongPath } from '../install/extract'
import { IniDocument, TOML_DIALECT, type IniSections } from './iniService'
import { classifySkseDll, type SkseDllVerdict } from '../launch/skseDllPreflight'

export const ENGINE_FIXES_DLL = 'EngineFixes.dll'
export const ENGINE_FIXES_TOML = 'EngineFixes.toml'
/** Path Data-relative della DLL (case tollerante lato Windows; usato dal planner/deploy). */
export const ENGINE_FIXES_DLL_REL = `SKSE/Plugins/${ENGINE_FIXES_DLL}`
export const ENGINE_FIXES_TOML_REL = `SKSE/Plugins/${ENGINE_FIXES_TOML}`

// Part 2 preloader: vive nella ROOT del gioco (non in Data), caricato prima di SKSE. DEVE
// essere della stessa versione della Part 1 — per questo va protetto insieme alla DLL.
const ENGINE_FIXES_ROOT_FILES = ['d3dx9_42.dll', 'tbbmalloc.dll', 'tbb.dll']

// ── 2. Config forzata ──────────────────────────────────────────────────────────────────────
/**
 * Chiavi imposte in EngineFixes.toml, sezione → chiave → valore. Entrambe stanno in [Patches]
 * nel toml reale di Engine Fixes.
 *   • MaxStdio = 8192  — tetto di handle di file aperti (default 512): con le 1739 mod della
 *     Opoal Collection il default causa falsa "save corruption" quando gli handle si esauriscono.
 *   • MemoryManager = true — allocatore globale sostitutivo, raccomandato/necessario a questo
 *     volume di plugin per la stabilità del motore.
 */
export const ENGINE_FIXES_FORCED_CONFIG: IniSections = {
  Patches: {
    MaxStdio: 8192,
    MemoryManager: true,
  },
}

/**
 * PURA: applica le chiavi forzate al testo TOML preservando tutto il resto (commenti, altre
 * chiavi, ordine, spaziatura ` = ` e commenti inline `#`). Sezione/chiave assenti vengono
 * aggiunte. Ritorna il nuovo testo.
 */
export function applyEngineFixesConfig(tomlText: string, forced: IniSections = ENGINE_FIXES_FORCED_CONFIG): string {
  const doc = new IniDocument(tomlText, TOML_DIALECT)
  for (const [section, kv] of Object.entries(forced))
    for (const [key, value] of Object.entries(kv)) doc.setValue(section, key, value)
  return doc.toString()
}

// ── 1. Validazione versione ──────────────────────────────────────────────────────────────────
export interface EngineFixesCompat {
  verdict: SkseDllVerdict // 'ok' | 'warning' | 'incompatible' | 'unknown'
  reason: string
  /** Versione dichiarata del plugin (SKSEPlugin_Version.pluginVersion), non del runtime. */
  pluginVersion: string | null
  /** Versioni di gioco che la DLL dichiara compatibili (vuoto se version-independent o ignoto). */
  compatibleVersions: string[]
  /** Versione dell'exe di Skyrim contro cui si è confrontato (null se non risolta). */
  runtimeVersion: string | null
}

/** PURA: classifica una EngineFixes.dll contro la versione del runtime di gioco. */
export function classifyEngineFixesDll(buf: Buffer, runtimeVersion: string | null | undefined): EngineFixesCompat {
  const r = classifySkseDll(buf, runtimeVersion ?? undefined)
  return {
    verdict: r.verdict,
    reason: r.reason,
    pluginVersion: r.data?.pluginVersion ?? null,
    compatibleVersions: r.data?.compatibleVersions ?? [],
    runtimeVersion: runtimeVersion ?? null,
  }
}

/**
 * PURA: avviso di cambio versione della Part 1. Il deploy sta per sostituire la
 * EngineFixes.dll deployata (vX) con una di versione DIVERSA (vY). La Part 2 (preloader
 * d3dx9_42.dll/tbbmalloc.dll nella ROOT del gioco) NON è gestita dal deploy e resta quella
 * vecchia: il mismatch Part1↔Part2 è l'incidente reale che ha fatto fallire il load di
 * po3_Tweaks/FLM (swap 6.1.1 → 7.0.20 col preloader rimasto indietro). Il gate
 * compatibleVersions non lo becca — entrambe le build dichiarano compat col gioco — quindi
 * serve questo confronto FileVersion↔FileVersion. null = nessun avviso (versioni uguali o
 * non confrontabili: primo deploy, PE senza risorsa versione).
 */
export function engineFixesVersionChangeWarning(
  deployedVersion: string | null,
  incomingVersion: string | null,
): string | null {
  if (!deployedVersion || !incomingVersion || deployedVersion === incomingVersion) return null
  return (
    `[WARNING] EngineFixes Part 1 aggiornata da v${deployedVersion} a v${incomingVersion}. ` +
    `Assicurati di aver aggiornato manualmente anche la Part 2 (d3dx9_42.dll/tbbmalloc.dll ` +
    `nella ROOT del gioco) alla stessa versione, o il gioco crasherà al caricamento.`
  )
}

// ── 3. Lockdown ───────────────────────────────────────────────────────────────────────────
/**
 * PURA: i file Engine Fixes da proteggere (read-only), assoluti. Part 1 (DLL + toml) sotto
 * `dataDir/SKSE/Plugins`; Part 2 (preloader) nella root del gioco se `gameDir` è noto.
 */
export function engineFixesProtectedFiles(dataDir: string, gameDir: string | null): string[] {
  const out = [join(dataDir, 'SKSE', 'Plugins', ENGINE_FIXES_DLL), join(dataDir, 'SKSE', 'Plugins', ENGINE_FIXES_TOML)]
  if (gameDir) for (const f of ENGINE_FIXES_ROOT_FILES) out.push(join(gameDir, f))
  return out
}

// ── Wrapper fs reali (no-throw salvo il blocco di versione, gestito dal chiamante) ──────────

/**
 * Legge e classifica la EngineFixes.dll dal percorso dato. Errore I/O → verdict 'unknown'
 * (mai un blocco: un file illeggibile non è la stessa cosa di uno provato incompatibile).
 */
export function checkEngineFixesCompatFile(dllPath: string, runtimeVersion: string | null | undefined): EngineFixesCompat {
  try {
    return classifyEngineFixesDll(readFileSync(toLongPath(dllPath)), runtimeVersion)
  } catch (e) {
    return {
      verdict: 'unknown',
      reason: `lettura EngineFixes.dll fallita: ${(e as Error).message}`,
      pluginVersion: null,
      compatibleVersions: [],
      runtimeVersion: runtimeVersion ?? null,
    }
  }
}

export interface EngineFixesConfigResult {
  written: boolean
  /** true se il file esisteva ed è stato modificato/riscritto; false se creato ex-novo o skip. */
  existed: boolean
  error?: string
}

/**
 * Inietta la config forzata nel EngineFixes.toml al percorso dato. Se il file esiste ne preserva
 * il contenuto; se assente lo crea con le sole chiavi forzate. Scrittura ATOMICA (tmp+rename): il
 * toml deployato è un hardlink alla sorgente mod — il rename lo rimpiazza con una copia modificata
 * (nlink=1), lasciando la sorgente intatta. Fail-soft: ritorna l'errore, non lancia.
 */
export function injectEngineFixesConfigFile(
  tomlPath: string,
  forced: IniSections = ENGINE_FIXES_FORCED_CONFIG,
): EngineFixesConfigResult {
  let existed = false
  let text = ''
  try {
    text = readFileSync(toLongPath(tomlPath), 'utf8')
    existed = true
  } catch {
    // Assente/illeggibile: si crea con le sole chiavi forzate (blocco [Patches] minimo).
    existed = false
  }
  try {
    const next = applyEngineFixesConfig(text, forced)
    if (existed && next === text) return { written: false, existed: true }
    atomicWriteFile(tomlPath, next)
    return { written: true, existed }
  } catch (e) {
    return { written: false, existed, error: (e as Error).message }
  }
}

export interface LockResult {
  locked: number
  errors: string[]
}

/**
 * Marca (o smarca) read-only i file dati. best-effort: un file assente/non modificabile viene
 * saltato e conteggiato in `errors`, mai un throw. Su Windows chmod 0o444/0o644 mappa
 * sull'attributo read-only (stesso meccanismo di updateGuard.setReadOnly).
 */
export function setEngineFixesLock(files: string[], locked: boolean): LockResult {
  const res: LockResult = { locked: 0, errors: [] }
  for (const f of files) {
    try {
      const lp = toLongPath(f)
      statSync(lp) // salta i file assenti senza errore rumoroso
      chmodSync(lp, locked ? 0o444 : 0o644)
      res.locked++
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') res.errors.push(`${f}: ${(e as Error).message}`)
    }
  }
  return res
}
