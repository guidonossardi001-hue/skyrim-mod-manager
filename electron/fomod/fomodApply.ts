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

/** La mod ha un installer FOMOD alla radice? (ModuleConfig.xml sotto fomod/, case-insensitive) */
export function hasFomod(modDir: string): boolean {
  try {
    const entries = readdirSync(modDir)
    const fomodDir = entries.find((e) => e.toLowerCase() === 'fomod')
    if (!fomodDir) return false
    const inner = readdirSync(join(modDir, fomodDir))
    return inner.some((f) => f.toLowerCase() === 'moduleconfig.xml')
  } catch {
    return false
  }
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
  const native = loadNative()
  const sup = native.testSupported(files, ['XmlScript'])
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
  try {
    if (existsSync(mapped)) rmSync(mapped, { recursive: true, force: true })
    mkdirSync(mapped, { recursive: true })
    for (const c of copies) {
      const src = join(modDir, c.source)
      const dest = join(mapped, c.destination)
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
    const discard = modDir + '.smm-flat-discard'
    if (existsSync(discard)) rmSync(discard, { recursive: true, force: true })
    renameSync(modDir, discard)
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
    // Rollback: ogni file torna al suo posto, la mod resta flat e intatta.
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
