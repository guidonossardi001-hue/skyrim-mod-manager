// Gestione preset ENB — i preset vivono nella ROOT del gioco (enbseries.ini, enblocal.ini,
// cartelle enbseries/), NON in Data: il deploy hardlink non li copre per costruzione.
// Qui: scan dei preset dentro le mod estratte, apply nella root del gioco (COPIA, non
// hardlink: gli .ini vengono editati in gioco e non devono mutare la sorgente della mod),
// backup degli originali + manifest dedicato, remove che ripristina tutto.
//
// NOTA CORE ENB: il binario (d3d11.dll + d3dcompiler_46e.dll) viene da enbdev.com e NON è
// ridistribuibile nelle collection: se assente, l'apply avverte — il preset senza core non
// ha effetto. Non lo scarichiamo: download manuale dell'utente da enbdev.com.

import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, renameSync, unlinkSync, readFileSync, writeFileSync, rmdirSync } from 'fs'
import { join, dirname, basename } from 'path'

export const ENB_MANIFEST_FILE = '.smm-enb-manifest.json'
export const ENB_BACKUP_SUFFIX = '.smm-enb-bak'

// Firme di un preset ENB alla radice di una directory.
const ENB_MARKERS = ['enbseries.ini', 'enblocal.ini']
const ENB_DIRS = ['enbseries', 'enbcache']
// File che NON vanno mai copiati nella root del gioco (contenuto Data-like o archivi).
const EXCLUDE_RE = /\.(esp|esm|esl|bsa|ba2|7z|zip|rar|txt|md|url|jpg|jpeg|png|webp)$/i

export interface EnbPreset {
  modName: string // nome della cartella mod che lo contiene
  presetDir: string // directory il cui CONTENUTO va nella root del gioco
  label: string // etichetta leggibile (modName, o modName/sottocartella)
  files: number // conteggio file che verrebbero applicati
  hasCoreDll: boolean // il preset shippa anche d3d11.dll (raro: di solito serve enbdev.com)
}

export interface EnbManifest {
  version: 1
  gameRoot: string
  preset: string // label del preset applicato
  files: string[] // path RELATIVI alla root del gioco, creati dall'apply
  backups: string[] // path relativi i cui originali sono in <rel>.smm-enb-bak
}

/** true se `dir` è la radice di un preset ENB (contiene un marker o una cartella tipica). */
function looksLikePresetRoot(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    const lower = new Set(entries.map((e) => e.toLowerCase()))
    if (ENB_MARKERS.some((m) => lower.has(m))) return true
    return ENB_DIRS.some((d) => lower.has(d) && statSync(join(dir, entries.find((e) => e.toLowerCase() === d)!)).isDirectory())
  } catch {
    return false
  }
}

/** Elenco ricorsivo dei file applicabili sotto `root` (relativi, esclusi Data-like e backup). */
function listApplicableFiles(root: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string) => {
    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch {
      return
    }
    for (const e of entries) {
      const absChild = join(abs, e)
      const relChild = rel ? `${rel}/${e}` : e
      try {
        if (statSync(absChild).isDirectory()) walk(absChild, relChild)
        else if (!EXCLUDE_RE.test(e) && !e.endsWith(ENB_BACKUP_SUFFIX) && e !== ENB_MANIFEST_FILE)
          out.push(relChild)
      } catch {
        /* skip */
      }
    }
  }
  walk(root, '')
  return out
}

/**
 * Scansiona le mod estratte cercando preset ENB. Un preset è una directory (la root della
 * mod o una sua sottocartella di primo/secondo livello — i pack ne offrono spesso più
 * varianti, es. "Performance"/"Quality") che contiene enbseries.ini/enblocal.ini o
 * una cartella enbseries/.
 */
export function scanEnbPresets(modsRoot: string): EnbPreset[] {
  const presets: EnbPreset[] = []
  if (!existsSync(modsRoot)) return presets
  let modDirs: string[]
  try {
    modDirs = readdirSync(modsRoot).filter((d) => {
      try {
        return statSync(join(modsRoot, d)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return presets
  }
  const addIfPreset = (modName: string, dir: string, label: string) => {
    if (!looksLikePresetRoot(dir)) return false
    const files = listApplicableFiles(dir)
    if (!files.length) return false
    presets.push({
      modName,
      presetDir: dir,
      label,
      files: files.length,
      hasCoreDll: files.some((f) => basename(f).toLowerCase() === 'd3d11.dll'),
    })
    return true
  }
  for (const mod of modDirs) {
    const root = join(modsRoot, mod)
    if (addIfPreset(mod, root, mod)) continue
    // Varianti in sottocartelle (max 2 livelli: "00 Performance/", "Preset/Quality/", …).
    try {
      for (const sub of readdirSync(root)) {
        const subAbs = join(root, sub)
        try {
          if (!statSync(subAbs).isDirectory()) continue
        } catch {
          continue
        }
        if (addIfPreset(mod, subAbs, `${mod} / ${sub}`)) continue
        try {
          for (const sub2 of readdirSync(subAbs)) {
            const sub2Abs = join(subAbs, sub2)
            try {
              if (statSync(sub2Abs).isDirectory()) addIfPreset(mod, sub2Abs, `${mod} / ${sub} / ${sub2}`)
            } catch {
              /* skip */
            }
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  return presets
}

function readEnbManifest(gameRoot: string): EnbManifest | null {
  try {
    const p = join(gameRoot, ENB_MANIFEST_FILE)
    if (!existsSync(p)) return null
    const m = JSON.parse(readFileSync(p, 'utf8')) as EnbManifest
    if (m?.version !== 1 || !Array.isArray(m.files) || !Array.isArray(m.backups)) return null
    return m
  } catch {
    return null
  }
}

export interface EnbApplyResult {
  ok: boolean
  applied?: number
  backedUp?: number
  coreDllPresent?: boolean // d3d11.dll presente nella root del gioco DOPO l'apply
  removedPrevious?: boolean
  error?: string
}

/** Rimuove il preset ENB applicato (manifest-based) e ripristina gli originali. */
export function removeEnbPreset(gameRoot: string): { ok: boolean; removed: number; restored: number; error?: string } {
  const manifest = readEnbManifest(gameRoot)
  if (!manifest) return { ok: true, removed: 0, restored: 0 }
  let removed = 0
  let restored = 0
  const dirs = new Set<string>()
  for (const rel of manifest.files) {
    const abs = join(gameRoot, rel)
    try {
      if (existsSync(abs)) {
        unlinkSync(abs)
        removed++
      }
    } catch {
      /* fail-soft */
    }
    let d = dirname(rel)
    while (d && d !== '.') {
      dirs.add(d)
      d = dirname(d)
    }
  }
  for (const rel of manifest.backups) {
    const abs = join(gameRoot, rel)
    const bak = abs + ENB_BACKUP_SUFFIX
    try {
      if (existsSync(bak) && !existsSync(abs)) {
        renameSync(bak, abs)
        restored++
      } else if (existsSync(bak)) unlinkSync(bak)
    } catch {
      /* fail-soft */
    }
  }
  for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try {
      rmdirSync(join(gameRoot, d)) // solo se vuota
    } catch {
      /* non vuota */
    }
  }
  try {
    unlinkSync(join(gameRoot, ENB_MANIFEST_FILE))
  } catch {
    /* best effort */
  }
  return { ok: true, removed, restored }
}

/**
 * Applica il CONTENUTO di `presetDir` nella root del gioco: un preset precedente viene
 * prima rimosso (manifest), gli originali preesistenti vanno in <rel>.smm-enb-bak.
 * COPIA reale (mai hardlink): gli .ini vengono modificati in gioco.
 */
export function applyEnbPreset(presetDir: string, gameRoot: string, label: string): EnbApplyResult {
  if (!existsSync(presetDir)) return { ok: false, error: `Preset non trovato: ${presetDir}` }
  if (!existsSync(gameRoot)) return { ok: false, error: `Cartella gioco non trovata: ${gameRoot}` }
  const prev = readEnbManifest(gameRoot)
  const removedPrevious = !!prev
  if (prev) removeEnbPreset(gameRoot)

  const files = listApplicableFiles(presetDir)
  if (!files.length) return { ok: false, error: 'Il preset non contiene file applicabili' }
  const manifest: EnbManifest = { version: 1, gameRoot, preset: label, files: [], backups: [] }
  let backedUp = 0
  try {
    for (const rel of files) {
      const src = join(presetDir, rel)
      const dest = join(gameRoot, rel)
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) {
        const bak = dest + ENB_BACKUP_SUFFIX
        if (!existsSync(bak)) renameSync(dest, bak)
        else unlinkSync(dest) // il bak esistente contiene già l'originale vero
        manifest.backups.push(rel)
        backedUp++
      }
      copyFileSync(src, dest)
      manifest.files.push(rel)
    }
    writeFileSync(join(gameRoot, ENB_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const coreDllPresent = existsSync(join(gameRoot, 'd3d11.dll'))
  return { ok: true, applied: manifest.files.length, backedUp, coreDllPresent, removedPrevious }
}
