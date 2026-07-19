// Applicazione HEADLESS degli installer FOMOD alle mod estratte flat — usa il motore
// UFFICIALE di Vortex (@nexusmods/fomod-installer-native, N-API stabile, engine .NET AOT:
// nessun runtime esterno). Caso reale: 235/1739 mod della collection hanno un installer
// FOMOD e l'estrazione flat lascia gli asset dentro cartelle-opzione che il gioco ignora.
//
// Flusso per mod: file list stile-archivio → testSupported → install(preset=choices del
// curatore, preselect=true per i default sui gruppi non coperti) → instructions 'copy'
// applicate con RENAME journal-ato (rollback completo su errore) → la cartella mod diventa
// il layout finale Data-relative + marker .smm-fomod-applied.json (idempotenza).

import { readdirSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { createRequire } from 'module'
import { isPathInside } from '../install/extract'

export const FOMOD_MARKER = '.smm-fomod-applied.json'

// Stop patterns di Vortex (subset Skyrim): individuano la root "Data-like" dentro l'archivio.
export const STOP_PATTERNS = [
  '[^/\\\\]*\\.esp$',
  '[^/\\\\]*\\.esm$',
  '[^/\\\\]*\\.esl$',
  '[^/\\\\]*\\.bsa$',
  'fomod[/\\\\]',
  'textures[/\\\\]',
  'meshes[/\\\\]',
  'interface[/\\\\]',
  'skse[/\\\\]',
  'scripts[/\\\\]',
  'sound[/\\\\]',
  'seq[/\\\\]',
  'grass[/\\\\]',
  'strings[/\\\\]',
]

/** Preset FOMOD nel formato della collection (choices.options): array di step. */
export type FomodPreset = unknown[]

export interface FomodInstruction {
  type: string
  source: string
  destination: string
}

export interface FomodRunResult {
  ok: boolean
  supported: boolean
  instructions?: FomodInstruction[]
  message?: string
  error?: string
}

/** true se dir/fomod/ModuleConfig.xml esiste (case-insensitive). */
function fomodConfigAt(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    const fomodDir = entries.find((e) => e.toLowerCase() === 'fomod')
    if (!fomodDir) return false
    const inner = readdirSync(join(dir, fomodDir))
    return inner.some((f) => f.toLowerCase() === 'moduleconfig.xml')
  } catch {
    return false
  }
}

/**
 * La mod ha un installer FOMOD? Cerca ModuleConfig.xml alla radice E dentro i wrapper
 * (fino a 2 livelli): 137/1939 mod della collection arrivano come `<mod>/<wrapper>/fomod/…`
 * (es. `Reverb Overhaul/fomod/ModuleConfig.xml`) e il vecchio check solo-radice le rendeva
 * invisibili all'engine — asset in cartelle-opzione mai installati, plugin master assenti,
 * deploy bocciato a catena per "master mancanti". Il motore nativo trova da sé la config
 * OVUNQUE nella file list e le instruction portano già il prefisso wrapper: basta il gate.
 */
export function hasFomod(modDir: string): boolean {
  if (fomodConfigAt(modDir)) return true
  try {
    for (const l1 of readdirSync(modDir, { withFileTypes: true })) {
      if (!l1.isDirectory()) continue
      const p1 = join(modDir, l1.name)
      if (fomodConfigAt(p1)) return true
      for (const l2 of readdirSync(p1, { withFileTypes: true })) {
        if (l2.isDirectory() && fomodConfigAt(join(p1, l2.name))) return true
      }
    }
  } catch {
    /* dir illeggibile → nessun FOMOD rilevabile */
  }
  return false
}

export function fomodApplied(modDir: string): boolean {
  return existsSync(join(modDir, FOMOD_MARKER))
}

/** File list stile archivio: path relativi con backslash, directory con trailing backslash. */
export function listArchiveStyleFiles(modDir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string) => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}\\${e.name}` : e.name
      if (e.isDirectory()) {
        out.push(r + '\\')
        walk(join(abs, e.name), r)
      } else out.push(r)
    }
  }
  walk(modDir, '')
  return out
}

// Il modulo nativo si carica UNA volta e solo al primo uso (lazy: mai al boot).
let nativeInstaller: unknown = null
function loadNative(): {
  NativeModInstaller: new (
    pluginsGetAll: (activeOnly: boolean) => string[],
    appVersion: () => string,
    gameVersion: () => string,
    extenderVersion: (e: string) => string,
    uiStart: (name: string, img: unknown, sel: unknown, cont: (fwd: boolean, step: number) => void, cancel: () => void) => void,
    uiEnd: () => void,
    uiUpdate: (steps: unknown[], current: number) => void,
  ) => {
    install: (
      files: string[],
      stop: string[],
      pluginPath: string,
      scriptPath: string,
      preset: unknown,
      preselect: boolean,
      validate: boolean,
    ) => Promise<{ message: string; instructions: FomodInstruction[] } | null>
  }
  testSupported: (files: string[], types: string[]) => { supported: boolean }
} {
  if (!nativeInstaller) {
    // createRequire: il modulo è CJS con binding .node; import ESM/bundler lo romperebbe.
    const req = createRequire(__filename)
    const mod = req('@nexusmods/fomod-installer-native') as {
      NativeModInstaller: { testSupported: (f: string[], t: string[]) => { supported: boolean } }
    }
    nativeInstaller = {
      NativeModInstaller: mod.NativeModInstaller,
      testSupported: mod.NativeModInstaller.testSupported,
    }
  }
  return nativeInstaller as ReturnType<typeof loadNative>
}

export interface FomodContext {
  gameVersion: string // es. '1.6.1170.0'
  skseVersion: string // es. '2.2.6' ('' se ignoto)
  knownPlugins: string[] // nomi .esp/.esm/.esl per le fileDependency dei ModuleConfig
}

/** Esegue l'installer FOMOD headless. Auto-continue su ogni step: le selezioni vengono dal
 * preset (scelte del curatore) + preselect (default dell'autore sui gruppi non coperti). */
export async function runFomodHeadless(
  modDir: string,
  preset: FomodPreset,
  ctx: FomodContext,
): Promise<FomodRunResult> {
  const files = listArchiveStyleFiles(modDir)
  // loadNative/testSupported ERANO fuori da ogni try: un throw qui (modulo nativo non
  // caricabile, archivio malformato che manda in eccezione lo scanner) propagava fino al
  // chiamante e interrompeva l'INTERO apply-all a metà lista — un solo FOMOD patologico tra
  // ~1900 mod bastava a bloccare tutte le mod successive. Ora fallisce SOLO questa mod.
  let native: ReturnType<typeof loadNative>
  let sup: { supported: boolean }
  try {
    native = loadNative()
    sup = native.testSupported(files, ['XmlScript'])
  } catch (e) {
    return { ok: false, supported: false, error: `motore FOMOD non disponibile per questa mod: ${(e as Error).message}` }
  }
  if (!sup.supported) return { ok: false, supported: false, error: 'installer non XmlScript (richiede intervento manuale)' }
  try {
    // I callback del motore nativo scattano via setImmediate: un throw lì dentro NON è
    // catturato da questo try/catch (boundary async) e diventa un uncaughtException del main
    // — caso reale: `cont` non-funzione su alcuni installer ("a is not a function" ripetuto
    // nel log), col dialogo mai avanzato e `installer.install` in attesa PER SEMPRE
    // (apply-all fermo su una mod per mezz'ora). Doppia difesa: chiamate guardate/try-catch
    // nei callback + watchdog sull'install, così una mod patologica fallisce e si prosegue.
    let continueFn: ((fwd: boolean, step: number) => void) | null = null
    const safeContinue = (fn: unknown, step: number) => {
      if (typeof fn !== 'function') return
      setImmediate(() => {
        try {
          ;(fn as (fwd: boolean, step: number) => void)(true, step)
        } catch {
          /* dialogo già chiuso/step non valido: l'esito arriva comunque da install() o dal watchdog */
        }
      })
    }
    const installer = new native.NativeModInstaller(
      () => ctx.knownPlugins,
      () => '1.0.0',
      () => ctx.gameVersion,
      (ext) => (ext.toUpperCase() === 'SKSE' ? ctx.skseVersion : ''),
      (_name, _img, _sel, cont) => {
        continueFn = typeof cont === 'function' ? cont : null
        // Primo avanzamento: le selezioni sono già decise da preset/preselect.
        safeContinue(cont, 0)
      },
      () => {
        continueFn = null
      },
      (_steps, current) => {
        // Step successivi visibili: continua finché l'executor non chiude il dialogo.
        safeContinue(continueFn, current)
      },
    )
    const INSTALL_TIMEOUT_MS = 180_000
    const res = await Promise.race([
      installer.install(files, STOP_PATTERNS, modDir, modDir, preset ?? [], true, false),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), INSTALL_TIMEOUT_MS).unref?.()),
    ])
    if (res === 'timeout')
      return {
        ok: false,
        supported: true,
        error: `installer bloccato oltre ${INSTALL_TIMEOUT_MS / 1000}s (dialogo mai avanzato): saltato`,
      }
    if (!res) return { ok: false, supported: true, error: 'installer annullato/esito nullo' }
    return { ok: true, supported: true, message: res.message, instructions: res.instructions }
  } catch (e) {
    return { ok: false, supported: true, error: (e as Error).message }
  }
}

export interface FomodApplyResult {
  ok: boolean
  filesMapped?: number
  discarded?: number // file dell'estrazione flat NON scelti (varianti scartate) rimossi
  error?: string
}

/**
 * Applica le instruction 'copy' alla cartella estratta flat: RENAME (mai copie, stesso
 * volume) verso una dir .mapped sibling, journal per il rollback completo su errore, poi
 * swap atomico: la cartella mod diventa il layout finale + marker. Gli avanzi (opzioni non
 * scelte, fomod/) vengono ELIMINATI: la sorgente resta ricostruibile via re-download Premium.
 */
export function applyFomodInstructions(
  modDir: string,
  instructions: FomodInstruction[],
  meta: { preset: FomodPreset; message?: string },
): FomodApplyResult {
  const copies = instructions.filter((i) => i.type === 'copy' && i.source && i.destination)
  if (!copies.length) return { ok: false, error: 'nessuna instruction copy: installer senza esito utile' }
  const mapped = modDir + '.smm-mapped'
  const journal: { from: string; to: string }[] = []
  const discard = modDir + '.smm-flat-discard'
  // true SOLO dopo che modDir è stato rinominato in discard: da quel momento i path del
  // journal (dentro il vecchio modDir) non esistono più, quindi il rollback file-per-file
  // sarebbe un no-op silenzioso — la branca `swapped` nel catch usa una strategia diversa.
  let swapped = false
  try {
    if (existsSync(mapped)) rmSync(mapped, { recursive: true, force: true })
    mkdirSync(mapped, { recursive: true })
    for (const c of copies) {
      const src = join(modDir, c.source)
      const dest = join(mapped, c.destination)
      // ModuleConfig.xml è contenuto non fidato (autore della mod): source/destination
      // possono contenere '..' e uscire da modDir/mapped (path traversal, CWE-22). Le
      // altre pipeline derivate da archivio (extract.ts) hanno lo stesso guard: qui
      // l'instruction viene scartata invece di eseguire un renameSync fuori sandbox.
      if (!isPathInside(modDir, src) || !isPathInside(mapped, dest)) continue
      if (!existsSync(src)) continue // instruction su file assente (config malformato): skip
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) continue // duplicato (priority): il primo vince, come Vortex ordina
      renameSync(src, dest)
      journal.push({ from: src, to: dest })
    }
    if (!journal.length) {
      rmSync(mapped, { recursive: true, force: true })
      return { ok: false, error: 'nessun file spostato: sorgenti non trovate nella cartella estratta' }
    }
    // Marker DENTRO mapped, così lo swap lo porta in posizione.
    writeFileSync(
      join(mapped, FOMOD_MARKER),
      JSON.stringify({ appliedAt: new Date().toISOString(), message: meta.message, preset: meta.preset, copies: journal.length }, null, 2),
      'utf8',
    )
    // Swap: flat → .flat-discard, mapped → modDir, poi elimina gli avanzi.
    if (existsSync(discard)) rmSync(discard, { recursive: true, force: true })
    renameSync(modDir, discard)
    swapped = true
    renameSync(mapped, modDir)
    let discarded = 0
    try {
      discarded = listArchiveStyleFiles(discard).filter((f) => !f.endsWith('\\')).length
      rmSync(discard, { recursive: true, force: true })
    } catch {
      /* avanzi non eliminati: innocui, ripulibili a mano */
    }
    return { ok: true, filesMapped: journal.length, discarded }
  } catch (e) {
    // BUG REALE (fallimento del SECONDO rename dello swap, es. antivirus che tiene un handle
    // aperto su un file appena spostato): modDir è già stato rinominato in `discard`, quindi
    // i path del journal (dentro il VECCHIO modDir) non esistono più — il rollback file-per-file
    // sotto falliva silenzialmente per ognuno (catch "best effort"), e la riga seguente
    // cancellava `mapped` — che a quel punto era l'UNICA copia buona rimasta: perdita totale
    // della mod. Qui invece si desfa lo SWAP (discard → modDir) e `mapped` non viene mai
    // toccata: nel caso peggiore resta un artefatto orfano su disco, mai una mod distrutta.
    if (swapped) {
      try {
        if (!existsSync(modDir) && existsSync(discard)) renameSync(discard, modDir)
        return { ok: false, error: `swap verso il layout finale fallito, stato originale ripristinato: ${(e as Error).message}` }
      } catch {
        return {
          ok: false,
          error: `swap fallito e ripristino impossibile — i file originali sono salvi in "${discard}" (rinominala in "${modDir}" a mano): ${(e as Error).message}`,
        }
      }
    }
    // Fallimento PRIMA dello swap (durante il loop di copia): modDir esiste ancora nel suo
    // stato originale meno i file già spostati in `mapped` — il rollback file-per-file è corretto qui.
    for (const j of journal.reverse()) {
      try {
        renameSync(j.to, j.from)
      } catch {
        /* best effort */
      }
    }
    try {
      rmSync(mapped, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    return { ok: false, error: (e as Error).message }
  }
}

/** Legge il marker (per la UI). */
export function readFomodMarker(modDir: string): { appliedAt?: string; copies?: number } | null {
  try {
    return JSON.parse(readFileSync(join(modDir, FOMOD_MARKER), 'utf8'))
  } catch {
    return null
  }
}
