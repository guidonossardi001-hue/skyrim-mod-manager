import { existsSync, readdirSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// Pandora Behaviour Engine detection (PANDORA-REGISTER-01).
//
// STRICTLY detection + registration: locate the Pandora executable across candidate
// roots and report it. This module NEVER spawns Pandora and NEVER writes any output —
// persistence of the path is the caller's job (a settings:set), execution is not.
// IO is injected via FsProbe so the search policy is fully unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

export const PANDORA_EXE = 'Pandora Behaviour Engine+.exe'
const exeMatches = (name: string): boolean =>
  name.toLowerCase() === PANDORA_EXE.toLowerCase() || /pandora.*\.exe$/i.test(name)

export interface FsProbe {
  exists(p: string): boolean
  readdir(p: string): string[] // must NOT throw — return [] on error
  isDirectory(p: string): boolean
}

export interface PandoraDetect {
  path: string | null // the FOLDER containing the exe (engine root)
  exePath: string | null // full path to the executable
  exeFound: boolean
  candidatesTried: string[]
}

/**
 * Find the Pandora exe across the given roots. Each root may be the exe itself, the
 * engine folder, or a parent that holds engine subfolders (e.g. C:\pandora\<release>\…).
 * Searches the root and ONE level of subfolders. When several builds are found, prefers
 * a non-"Preview" build, then the lexicographically-highest path (newest version).
 */
export function findPandoraExe(roots: string[], fs: FsProbe): string | null {
  const found: string[] = []
  for (const root of roots.filter(Boolean)) {
    if (!fs.exists(root)) continue
    if (!fs.isDirectory(root)) {
      if (exeMatches(basename(root))) found.push(root)
      continue
    }
    // exe directly inside root
    for (const n of fs.readdir(root)) {
      const p = join(root, n)
      if (exeMatches(n) && !fs.isDirectory(p)) found.push(p)
    }
    // exe one level deep (C:\pandora\<release-folder>\exe)
    for (const sub of fs.readdir(root)) {
      const subPath = join(root, sub)
      if (!fs.isDirectory(subPath)) continue
      for (const n of fs.readdir(subPath)) {
        const p = join(subPath, n)
        if (exeMatches(n) && !fs.isDirectory(p)) found.push(p)
      }
    }
  }
  if (!found.length) return null
  const isPreview = (s: string) => /preview/i.test(s)
  found.sort((a, b) => Number(isPreview(a)) - Number(isPreview(b)) || b.localeCompare(a))
  return found[0]
}

/** Detect Pandora across candidate roots (pure given an FsProbe). */
export function detectPandora(roots: string[], fs: FsProbe): PandoraDetect {
  const exe = findPandoraExe(roots, fs)
  return {
    path: exe ? dirname(exe) : null,
    exePath: exe,
    exeFound: !!exe,
    candidatesTried: roots.filter(Boolean),
  }
}

/** Default candidate roots: the saved setting first, then common install locations. */
export function pandoraRoots(savedPath?: string | null, home?: string): string[] {
  const roots = [savedPath || undefined, 'C:/pandora', 'C:/Pandora', 'C:/Tools/pandora']
  if (home) roots.push(join(home, 'pandora'))
  return roots.filter((p): p is string => !!p)
}

/** Production FsProbe over the real filesystem (read-only; readdir never throws). */
export const realFsProbe: FsProbe = {
  exists: existsSync,
  readdir: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  },
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
}
