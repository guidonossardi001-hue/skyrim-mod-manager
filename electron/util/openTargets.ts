import { extname, resolve, join, isAbsolute } from 'path'
import { isPathInside } from '../install/extract'

// Security core for the "open a folder / reveal a downloaded file" IPC surface.
//
// The renderer NEVER passes a filesystem path: it names an INTENT — a fixed folder
// `kind` (backups, downloads, logs, game, mo2, mods, stockGame, instances) or a numeric
// download id. The main process resolves the concrete path from the settings store / DB,
// so a compromised renderer cannot ask the OS to open (and, for executables, RUN) an
// arbitrary local file. This module holds the pure, injectable pieces so the whole
// decision is unit-testable with fake fs probes; main.ts only wires app/store/db to it.

// Extensions that shell.openPath would EXECUTE, not merely display. Refused even inside an
// authorized root — a mod archive can extract a .exe into the (whitelisted) mods folder, and
// opening it would run it. Directories (no extension) and data archives (.7z/.zip/.rar) pass.
export const EXECUTABLE_EXTS = new Set<string>([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.msc', '.jar', '.reg', '.lnk', '.url',
  '.inf', '.gadget', '.application', '.sct',
])

export function isExecutablePath(p: string): boolean {
  return EXECUTABLE_EXTS.has(extname(p).toLowerCase())
}

// The authorized folder intents. This list IS the whitelist: the renderer can name only
// these, and each maps main-side to exactly one directory.
export const REVEAL_KINDS = [
  'backups', 'downloads', 'logs', 'game', 'mo2', 'mods', 'stockGame', 'instances',
] as const
export type RevealKind = (typeof REVEAL_KINDS)[number]

export function isRevealKind(v: unknown): v is RevealKind {
  return typeof v === 'string' && (REVEAL_KINDS as readonly string[]).includes(v)
}

/** Directory paths (already resolved by the caller from app.getPath/store), one per kind. */
export interface RevealRoots {
  backups: string
  downloads: string
  logs: string
  mods: string
  stockGame: string
  instances: string
  game: string | null // user-configured; may be unset
  mo2: string | null // parent dir of ModOrganizer.exe; may be unset
}

/** Resolve an authorized folder intent to its directory, or null if unknown/unconfigured. */
export function revealDirForKind(kind: unknown, roots: RevealRoots): string | null {
  if (!isRevealKind(kind)) return null
  return roots[kind] ?? null
}

/** All non-null authorized roots — the containment set for reveal-a-file checks. */
export function allowedRoots(roots: RevealRoots): string[] {
  return REVEAL_KINDS.map((k) => roots[k]).filter((r): r is string => !!r)
}

export interface RevealProbe {
  exists: (p: string) => boolean
  /** Resolve symlinks/junctions to the real path (defeats a junction that escapes a root). */
  realpath: (p: string) => string
}

/** Canonicalize a path: real path when it exists (symlink-safe), else a plain resolve. */
function canonical(p: string, probe: RevealProbe): string {
  try {
    return probe.exists(p) ? probe.realpath(p) : resolve(p)
  } catch {
    return resolve(p)
  }
}

export type OpenDecision = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Decide whether a concrete file path (resolved main-side from a download id) may be revealed.
 * Rejects: empty, UNC (\\server\share — could pull a remote payload), executables, and anything
 * that does not resolve INSIDE one of the authorized roots (after symlink/junction resolution).
 */
export function validateOpenPath(
  rawPath: string,
  roots: RevealRoots,
  probe: RevealProbe,
): OpenDecision {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, reason: 'percorso vuoto' }
  if (/^\\\\/.test(rawPath) || /^\/\//.test(rawPath)) return { ok: false, reason: 'percorso UNC non consentito' }

  const p = canonical(rawPath, probe)
  if (isExecutablePath(p)) return { ok: false, reason: `estensione eseguibile non consentita (${extname(p)})` }

  const resolvedRoots = allowedRoots(roots).map((r) => canonical(r, probe))
  if (!resolvedRoots.some((root) => isPathInside(root, p))) {
    return { ok: false, reason: 'percorso fuori dalle cartelle autorizzate' }
  }
  return { ok: true, path: p }
}

/**
 * Resolve a directory-listing target for the intent-based fs:read-dir. The renderer names a
 * folder `kind` (never an absolute path); an optional RELATIVE subpath may descend within that
 * ONE root. The result is confined to the kind's own root (not just "some authorized root"):
 * a read-dir of 'backups' can never wander into 'mods'. `..` and symlink/junction escapes are
 * defeated by canonicalizing (realpath) both base and target before the containment check.
 */
export function resolveReadDir(
  kind: unknown,
  roots: RevealRoots,
  subpath: string | undefined,
  probe: RevealProbe,
): OpenDecision {
  const base = revealDirForKind(kind, roots)
  if (!base) return { ok: false, reason: 'cartella non disponibile' }
  if (subpath !== undefined && subpath !== '') {
    if (typeof subpath !== 'string') return { ok: false, reason: 'subpath non valido' }
    // An absolute or UNC subpath would ignore `base` entirely once join'd — refuse outright.
    if (isAbsolute(subpath) || /^\\\\/.test(subpath) || /^\/\//.test(subpath)) {
      return { ok: false, reason: 'subpath assoluto non consentito' }
    }
  }
  const target = subpath ? join(base, subpath) : base
  const cBase = canonical(base, probe)
  const cTarget = canonical(target, probe)
  if (!isPathInside(cBase, cTarget)) {
    return { ok: false, reason: 'percorso fuori dalla cartella autorizzata' }
  }
  return { ok: true, path: cTarget }
}
