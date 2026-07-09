import { join, dirname } from 'path'
import { detectSteamEnv } from '../steam/detect'
import { detect7zPath } from '../install/sevenZip'
import { findPandoraExe, pandoraRoots, realFsProbe, type FsProbe } from './pandora'

// ─────────────────────────────────────────────────────────────────────────────
// Advanced auto-detection of game + tool paths (Nolvus-style installer).
//
// Sequential, SILENT-FALLBACK detection so the "Percorsi Gioco e Strumenti" screen
// never needs manual setup: locate the Skyrim SE/AE install from the Steam registry
// (via steam/detect → reg.exe, no extra deps, read-only) and scan a curated set of
// roots for the common modding tool executables. A tool that is not found simply
// stays unset — never blocks. IO is injected (FsProbe) so the scan is unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectedPaths {
  gamePath?: string
  modsPath?: string
  mo2Path?: string
  sevenZipPath?: string
  lootPath?: string
  sseeditPath?: string
  dyndolodPath?: string
  xlodgenPath?: string
  pandoraPath?: string
}

export interface ToolSpec {
  key: string
  exes: string[]
}

// Modding tools located by a bounded filesystem scan (7-Zip + Pandora are resolved by
// their own dedicated detectors and composed in below).
export const TOOL_SPECS: ToolSpec[] = [
  { key: 'mo2', exes: ['ModOrganizer.exe'] },
  { key: 'loot', exes: ['LOOT.exe'] },
  { key: 'sseedit', exes: ['SSEEdit.exe', 'SSEEditx64.exe', 'SSEEdit64.exe'] },
  { key: 'dyndolod', exes: ['DynDOLODx64.exe', 'DynDOLOD.exe'] },
  { key: 'xlodgen', exes: ['xLODGen.exe', 'xLODGenx64.exe'] },
]

// Directories never worth descending into (huge / system / irrelevant).
const SKIP_DIRS = new Set([
  'windows',
  'windowsapps',
  '$recycle.bin',
  'system volume information',
  'node_modules',
  'packagecache',
  '.git',
  'microsoft',
  'temp',
  'tmp',
  'cache',
  '$windows.~bt',
  'recovery',
])

/**
 * Single-pass bounded scan: walks each root up to maxDepth, matching every file against
 * the union of wanted exe names, recording the FIRST match per tool. Stops early once all
 * tools are found. Skips system/huge dirs. Pure given an FsProbe.
 */
export function scanForExes(
  roots: string[],
  tools: ToolSpec[],
  fs: FsProbe,
  maxDepth = 3,
): Record<string, string> {
  const wanted = new Map<string, string>() // lowercased exe → toolKey
  for (const t of tools) for (const e of t.exes) wanted.set(e.toLowerCase(), t.key)
  const found: Record<string, string> = {}
  const remaining = new Set(tools.map((t) => t.key))
  const seen = new Set<string>()

  const scan = (dir: string, depth: number): void => {
    if (depth > maxDepth || remaining.size === 0) return
    const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (seen.has(norm)) return
    seen.add(norm)
    let entries: string[]
    try {
      entries = fs.readdir(dir)
    } catch {
      return
    }
    // files first (a match at this level wins)
    for (const n of entries) {
      const tk = wanted.get(n.toLowerCase())
      if (tk && remaining.has(tk)) {
        const p = join(dir, n)
        if (!fs.isDirectory(p)) {
          found[tk] = p
          remaining.delete(tk)
        }
      }
    }
    if (remaining.size === 0) return
    for (const n of entries) {
      if (SKIP_DIRS.has(n.toLowerCase())) continue
      const p = join(dir, n)
      if (fs.isDirectory(p)) scan(p, depth + 1)
    }
  }

  for (const root of roots) {
    if (remaining.size === 0) break
    scan(root, 0)
  }
  return found
}

export interface DetectDeps {
  gamePath: string | null
  steamLibraries: string[]
  sevenZip: string | null
  pandora: string | null
  home?: string
  localAppData?: string
  fs: FsProbe
}

/** Curated candidate roots (existing only, de-duplicated) for the tool scan. */
export function standardToolRoots(deps: DetectDeps): string[] {
  const cand: (string | undefined)[] = []
  if (deps.gamePath) cand.push(deps.gamePath, dirname(deps.gamePath))
  cand.push('C:/Games', 'C:/Modding', 'C:/Mods', 'C:/Tools', 'C:/Modlists', 'C:/Wabbajack')
  if (deps.home)
    cand.push(join(deps.home, 'Desktop'), join(deps.home, 'Downloads'), join(deps.home, 'Documents'))
  if (deps.localAppData) cand.push(join(deps.localAppData, 'ModOrganizer'), join(deps.localAppData, 'LOOT'))
  cand.push('C:/Program Files/LOOT', 'C:/Program Files', 'C:/Program Files (x86)')
  for (const lib of deps.steamLibraries) cand.push(lib, join(lib, 'steamapps', 'common'))
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of cand) {
    if (!p) continue
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!seen.has(n) && deps.fs.exists(p)) {
      seen.add(n)
      out.push(p)
    }
  }
  return out
}

/** Compose the full detected-paths map (pure given deps + FsProbe). */
export function detectToolPaths(deps: DetectDeps): DetectedPaths {
  const out: DetectedPaths = {}
  if (deps.gamePath) out.gamePath = deps.gamePath
  if (deps.sevenZip) out.sevenZipPath = deps.sevenZip
  if (deps.pandora) out.pandoraPath = deps.pandora

  const found = scanForExes(standardToolRoots(deps), TOOL_SPECS, deps.fs)
  if (found.mo2) {
    out.mo2Path = found.mo2
    const mods = join(dirname(found.mo2), 'mods') // portable MO2 → <dir>/mods
    if (deps.fs.exists(mods)) out.modsPath = mods
  }
  if (found.loot) out.lootPath = found.loot
  if (found.sseedit) out.sseeditPath = found.sseedit
  if (found.dyndolod) out.dyndolodPath = found.dyndolod
  if (found.xlodgen) out.xlodgenPath = found.xlodgen
  return out
}

/** Production entry: wires the real Steam probe, 7-Zip + Pandora detectors, and real fs. */
export function autoDetectPaths(): DetectedPaths {
  const env = detectSteamEnv()
  let sevenZip: string | null = null
  try {
    sevenZip = detect7zPath(realFsProbe.exists) ?? null
  } catch {
    sevenZip = null
  }
  const pandora = findPandoraExe(pandoraRoots(undefined, process.env.USERPROFILE), realFsProbe)
  return detectToolPaths({
    gamePath: env.skyrim.path,
    steamLibraries: env.steam.libraries,
    sevenZip,
    pandora,
    home: process.env.USERPROFILE,
    localAppData: process.env.LOCALAPPDATA,
    fs: realFsProbe,
  })
}
