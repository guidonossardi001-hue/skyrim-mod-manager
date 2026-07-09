import { existsSync, mkdirSync, readdirSync, statSync, linkSync, copyFileSync } from 'fs'
import { link as linkAsync, copyFile as copyFileAsync, mkdir as mkdirAsync } from 'fs/promises'
import { join, dirname } from 'path'

// ── StockGame builder (Wabbajack/Nolvus-style) ───────────────────────────────
//
// Creates an ISOLATED copy of the VANILLA Skyrim SE/AE base game so the modded
// setup never touches the real Steam install. COMPANION-MODE SAFE: strictly
// READ-ONLY on the source (the Steam game folder) — it only writes into the
// target StockGame folder, and never launches or mutates Steam.
//
// The source may be a *clean* vanilla install OR a heavily-modded one (Vortex/MO2
// deploy loose files and extra BSAs straight into Data). A WHITELIST classifier
// copies ONLY known-vanilla files — base/DLC/Creation-Club BSAs + ESM/ESL, the
// root executables, the Steam DRM dlls, and the vanilla Video/Strings folders —
// and SKIPS everything else (loose mod meshes/textures/scripts, mod BSAs, SKSE,
// ENB binaries, …). This is what keeps a 236 GB modded folder from bloating the
// StockGame: only the ~15 GB vanilla set is pulled.
//
// Copy strategy: HARDLINK-FIRST. On the same NTFS volume a hardlink shares the
// inode, so the StockGame costs ~0 extra bytes and is created in seconds; across
// volumes (or if linking fails with EXDEV) it falls back to a real byte copy.
// Pure classifiers are split out so the whole policy is unit-testable with no IO.

// ── Vanilla file policy (pure data) ──────────────────────────────────────────

/** Root-folder files that belong to the vanilla install. */
export const ROOT_VANILLA_FILES = new Set<string>([
  'skyrimse.exe',
  'skyrimselauncher.exe',
  'steam_api64.dll',
  'binkw64.dll', // SE 1.5.x
  'bink2w64.dll', // AE 1.6.x
  'steam_appid.txt',
])

/** Root-folder sub-directories that are vanilla (e.g. VC++ redistributables). */
export const ROOT_VANILLA_DIRS = new Set<string>(['_commonredist'])

/** Data-folder files matching any of these are vanilla base/DLC/Creation-Club content. */
export const DATA_VANILLA_PATTERNS: RegExp[] = [
  /^skyrim\.esm$/i,
  /^update\.(esm|bsa)$/i,
  /^dawnguard\.esm$/i,
  /^hearthfires\.esm$/i,
  /^dragonborn\.esm$/i,
  /^skyrim - .+\.bsa$/i, // base BSAs: Meshes/Textures0-8/Voices_xx/Interface/…
  /^cc[a-z0-9]+-.+\.(esl|esm|bsa)$/i, // Creation Club / Anniversary content
  /^_resourcepack\.(esl|bsa)$/i, // AE free CC bundle
  /^marketplacetextures\.bsa$/i,
  /^skyrim\.ccc$/i, // Creation Club load order
]

/** Data-folder sub-directories that are vanilla and copied recursively. */
export const DATA_VANILLA_DIRS = new Set<string>(['video', 'strings'])

/** Files whose presence in the StockGame we VERIFY after the copy (load-bearing). */
export const REQUIRED_VANILLA_FILES: string[] = ['SkyrimSE.exe', 'Data/Skyrim.esm', 'Data/Update.esm']

export type FileKind = 'vanilla' | 'skip'

/** Classify a top-level entry in the game ROOT folder. */
export function classifyRootEntry(name: string, isDir: boolean): FileKind {
  const lower = name.toLowerCase()
  if (isDir) {
    if (lower === 'data') return 'vanilla' // handled with its own per-entry policy
    return ROOT_VANILLA_DIRS.has(lower) ? 'vanilla' : 'skip'
  }
  return ROOT_VANILLA_FILES.has(lower) ? 'vanilla' : 'skip'
}

/** Classify a top-level entry in the Data folder. */
export function classifyDataEntry(name: string, isDir: boolean): FileKind {
  const lower = name.toLowerCase()
  if (isDir) return DATA_VANILLA_DIRS.has(lower) ? 'vanilla' : 'skip'
  return DATA_VANILLA_PATTERNS.some((re) => re.test(name)) ? 'vanilla' : 'skip'
}

// ── Hybrid isolation policy ───────────────────────────────────────────────────
//
// HARDLINK-FIRST is unsafe for the load-bearing, mutation-sensitive files: a
// hardlink shares the inode with the Steam source, so a Steam verify/update — or
// any tool that writes the source file in place — would silently reach into the
// "isolated" StockGame. So we force a REAL physical copy for the executables and
// every plugin/load-order file (.esm/.esl/.ccc); the large, effectively read-only
// bulk (.bsa archives + the Strings/ and Video/ folders) may still be hardlinked
// to keep the StockGame at ~0 extra bytes.

/** Root executables that must never be a hardlink (independent from Steam). */
export const PHYSICAL_COPY_ROOT_FILES = new Set<string>(['skyrimse.exe', 'skyrimselauncher.exe'])

/** Plugin/load-order extensions that must be a real copy (not a hardlink). */
export const PHYSICAL_COPY_EXTS = /\.(esm|esl|ccc)$/i

/**
 * True ⇒ this planned file MUST be a real byte copy (never a hardlink), even on
 * the same volume. `rel` is the path relative to the game root (forward slashes).
 */
export function requiresPhysicalCopy(rel: string): boolean {
  const base = rel.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return PHYSICAL_COPY_ROOT_FILES.has(base) || PHYSICAL_COPY_EXTS.test(base)
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlannedFile {
  src: string // absolute source path
  rel: string // path relative to the game root (forward slashes)
  bytes: number
}

export interface StockGamePlan {
  sourceGameDir: string
  files: PlannedFile[]
  totalBytes: number
  skippedFiles: number // non-vanilla entries deliberately left behind
  skippedBytes: number
}

function walkVanillaDir(absDir: string, relDir: string, out: PlannedFile[]): void {
  // Recursively include every file under a known-vanilla directory (Video, Strings, _CommonRedist).
  let entries: string[]
  try {
    entries = readdirSync(absDir)
  } catch {
    return
  }
  for (const name of entries) {
    const abs = join(absDir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    const rel = relDir ? `${relDir}/${name}` : name
    if (st.isDirectory()) walkVanillaDir(abs, rel, out)
    else out.push({ src: abs, rel, bytes: st.size })
  }
}

/** Build the copy plan by classifying the real source tree (READ-ONLY). */
export function planStockGame(sourceGameDir: string): StockGamePlan {
  const files: PlannedFile[] = []
  let skippedFiles = 0
  let skippedBytes = 0

  const addClassified = (
    absDir: string,
    relPrefix: string,
    classify: (name: string, isDir: boolean) => FileKind,
    onVanillaDir: (abs: string, rel: string) => void,
  ) => {
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(absDir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      const isDir = st.isDirectory()
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      const kind = classify(name, isDir)
      if (kind === 'skip') {
        if (!isDir) {
          skippedFiles++
          skippedBytes += st.size
        } else skippedFiles++ // a skipped directory (mod content) — counted as one entry
        continue
      }
      if (isDir) onVanillaDir(abs, rel)
      else files.push({ src: abs, rel, bytes: st.size })
    }
  }

  // ROOT: classify top-level; recurse into vanilla dirs; Data gets its own policy.
  addClassified(sourceGameDir, '', classifyRootEntry, (abs, rel) => {
    if (rel.toLowerCase() === 'data') {
      addClassified(abs, 'Data', classifyDataEntry, (dAbs, dRel) => walkVanillaDir(dAbs, dRel, files))
    } else {
      walkVanillaDir(abs, rel, files)
    }
  })

  const totalBytes = files.reduce((a, f) => a + f.bytes, 0)
  return { sourceGameDir, files, totalBytes, skippedFiles, skippedBytes }
}

// ── Create ───────────────────────────────────────────────────────────────────

export type StockGameMode = 'hardlink' | 'copy'

export interface StockGameProgress {
  phase: 'scanning' | 'copying' | 'verifying' | 'done'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  currentFile?: string
}

export interface StockGameResult {
  targetDir: string
  mode: StockGameMode
  filesTotal: number
  bytesTotal: number
  hardlinked: number
  copied: number
  alreadyPresent: number
  skippedFiles: number
  skippedBytes: number
  missingRequired: string[] // empty ⇒ verification passed
}

export interface StockGameOptions {
  sourceGameDir: string
  targetDir: string
  mode?: StockGameMode // default 'hardlink'
}

/** Same Windows volume? (hardlinks only work within one volume.) */
export function sameVolume(a: string, b: string): boolean {
  if (process.platform !== 'win32') return true // POSIX: try link, fall back on EXDEV
  const da = a.match(/^([a-zA-Z]):/)?.[1]?.toLowerCase()
  const dbb = b.match(/^([a-zA-Z]):/)?.[1]?.toLowerCase()
  return !!da && da === dbb
}

/** Default StockGame location under the app's userData folder. */
export function defaultStockGameDir(userData: string): string {
  return join(userData, 'StockGame')
}

function placeFile(src: string, dest: string, preferLink: boolean): 'hardlinked' | 'copied' | 'present' {
  if (existsSync(dest)) return 'present' // idempotent re-run
  mkdirSync(dirname(dest), { recursive: true })
  if (preferLink) {
    try {
      linkSync(src, dest)
      return 'hardlinked'
    } catch (e) {
      // EXDEV (cross-device), EPERM, or FS without hardlinks → real copy
      const code = (e as NodeJS.ErrnoException).code
      if (code && code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK') {
        // unexpected: still try a copy as last resort rather than aborting the whole build
      }
    }
  }
  copyFileSync(src, dest)
  return 'copied'
}

/**
 * Build the StockGame. Validates the source has the core vanilla files, copies
 * only the whitelisted vanilla set (hardlink-first), then verifies the required
 * files landed. Throws only on an unusable source; per-file link failures degrade
 * gracefully to a copy.
 */
export function createStockGame(
  opts: StockGameOptions,
  onProgress?: (p: StockGameProgress) => void,
): StockGameResult {
  const { sourceGameDir, targetDir } = opts
  const mode: StockGameMode = opts.mode ?? 'hardlink'

  if (!existsSync(sourceGameDir)) throw new Error(`Sorgente gioco non trovata: ${sourceGameDir}`)
  if (
    !existsSync(join(sourceGameDir, 'SkyrimSE.exe')) ||
    !existsSync(join(sourceGameDir, 'Data', 'Skyrim.esm'))
  ) {
    throw new Error(
      "La sorgente non sembra un'installazione Skyrim SE/AE valida (manca SkyrimSE.exe o Data/Skyrim.esm)",
    )
  }

  onProgress?.({ phase: 'scanning', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 })
  const plan = planStockGame(sourceGameDir)

  const preferLink = mode === 'hardlink' && sameVolume(sourceGameDir, targetDir)
  mkdirSync(targetDir, { recursive: true })

  let hardlinked = 0,
    copied = 0,
    alreadyPresent = 0,
    bytesDone = 0
  const filesTotal = plan.files.length
  for (let i = 0; i < filesTotal; i++) {
    const f = plan.files[i]
    const placed = placeFile(f.src, join(targetDir, f.rel), preferLink && !requiresPhysicalCopy(f.rel))
    if (placed === 'hardlinked') hardlinked++
    else if (placed === 'copied') copied++
    else alreadyPresent++
    bytesDone += f.bytes
    onProgress?.({
      phase: 'copying',
      filesDone: i + 1,
      filesTotal,
      bytesDone,
      bytesTotal: plan.totalBytes,
      currentFile: f.rel,
    })
  }

  onProgress?.({
    phase: 'verifying',
    filesDone: filesTotal,
    filesTotal,
    bytesDone,
    bytesTotal: plan.totalBytes,
  })
  const missingRequired = REQUIRED_VANILLA_FILES.filter((rel) => !existsSync(join(targetDir, rel)))

  onProgress?.({ phase: 'done', filesDone: filesTotal, filesTotal, bytesDone, bytesTotal: plan.totalBytes })
  return {
    targetDir,
    mode: preferLink ? 'hardlink' : 'copy',
    filesTotal,
    bytesTotal: plan.totalBytes,
    hardlinked,
    copied,
    alreadyPresent,
    skippedFiles: plan.skippedFiles,
    skippedBytes: plan.skippedBytes,
    missingRequired,
  }
}

async function placeFileAsync(
  src: string,
  dest: string,
  preferLink: boolean,
): Promise<'hardlinked' | 'copied' | 'present'> {
  if (existsSync(dest)) return 'present'
  await mkdirAsync(dirname(dest), { recursive: true })
  if (preferLink) {
    try {
      await linkAsync(src, dest)
      return 'hardlinked'
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code && code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK') {
        /* fall through to copy */
      }
    }
  }
  await copyFileAsync(src, dest)
  return 'copied'
}

/**
 * Async build — same policy as createStockGame but uses fs/promises and yields
 * the event loop between files so a multi-GB cross-volume copy never freezes the
 * UI thread. Progress is throttled to ~every 150ms (plus phase transitions).
 */
export async function createStockGameAsync(
  opts: StockGameOptions,
  onProgress?: (p: StockGameProgress) => void,
): Promise<StockGameResult> {
  const { sourceGameDir, targetDir } = opts
  const mode: StockGameMode = opts.mode ?? 'hardlink'

  if (!existsSync(sourceGameDir)) throw new Error(`Sorgente gioco non trovata: ${sourceGameDir}`)
  if (
    !existsSync(join(sourceGameDir, 'SkyrimSE.exe')) ||
    !existsSync(join(sourceGameDir, 'Data', 'Skyrim.esm'))
  ) {
    throw new Error(
      "La sorgente non sembra un'installazione Skyrim SE/AE valida (manca SkyrimSE.exe o Data/Skyrim.esm)",
    )
  }

  onProgress?.({ phase: 'scanning', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 })
  const plan = planStockGame(sourceGameDir)
  const preferLink = mode === 'hardlink' && sameVolume(sourceGameDir, targetDir)
  await mkdirAsync(targetDir, { recursive: true })

  let hardlinked = 0,
    copied = 0,
    alreadyPresent = 0,
    bytesDone = 0
  const filesTotal = plan.files.length
  let lastEmit = 0
  const now = () => globalThis.performance?.now?.() ?? 0
  for (let i = 0; i < filesTotal; i++) {
    const f = plan.files[i]
    const placed = await placeFileAsync(
      f.src,
      join(targetDir, f.rel),
      preferLink && !requiresPhysicalCopy(f.rel),
    )
    if (placed === 'hardlinked') hardlinked++
    else if (placed === 'copied') copied++
    else alreadyPresent++
    bytesDone += f.bytes
    const t = now()
    if (i === filesTotal - 1 || t - lastEmit >= 150) {
      lastEmit = t
      onProgress?.({
        phase: 'copying',
        filesDone: i + 1,
        filesTotal,
        bytesDone,
        bytesTotal: plan.totalBytes,
        currentFile: f.rel,
      })
    }
  }

  onProgress?.({
    phase: 'verifying',
    filesDone: filesTotal,
    filesTotal,
    bytesDone,
    bytesTotal: plan.totalBytes,
  })
  const missingRequired = REQUIRED_VANILLA_FILES.filter((rel) => !existsSync(join(targetDir, rel)))

  onProgress?.({ phase: 'done', filesDone: filesTotal, filesTotal, bytesDone, bytesTotal: plan.totalBytes })
  return {
    targetDir,
    mode: preferLink ? 'hardlink' : 'copy',
    filesTotal,
    bytesTotal: plan.totalBytes,
    hardlinked,
    copied,
    alreadyPresent,
    skippedFiles: plan.skippedFiles,
    skippedBytes: plan.skippedBytes,
    missingRequired,
  }
}
