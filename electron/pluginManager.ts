import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'fs'
import type { LoadOrderEntry, SaveLoadOrderResult } from '../src/types'

// v1.1.0 "Conflict & Load Order" — visibility layer. Reads the EFFECTIVE load
// order Skyrim uses: merges the game's real plugins.txt
// (%LOCALAPPDATA%/Skyrim Special Edition/plugins.txt) with the .esp/.esm/.esl
// files present in the Data directory (or the folder where mods are hardlinked).
//
// Split into a pure core (parse/scan/merge — no Electron, no store) and a thin
// IO orchestrator (getLoadOrder), matching the rest of electron/*: the merge
// logic is fully unit-testable with injected strings/paths. Never throws — a
// missing/unreadable plugins.txt (Skyrim writes it on first launch) degrades to
// a disk-only listing.

const PLUGIN_EXT = /\.(esp|esm|esl)$/i

// Base masters are loaded (and active) implicitly by the engine even when absent
// from plugins.txt. Lowercased for case-insensitive matching (Windows FS).
const BASE_MASTER_ORDER = [
  'skyrim.esm',
  'update.esm',
  'dawnguard.esm',
  'hearthfires.esm',
  'dragonborn.esm',
]
const BASE_MASTERS = new Set(BASE_MASTER_ORDER)

export interface PluginsTxtEntry {
  name: string
  active: boolean
}

/**
 * Parse a Skyrim SE plugins.txt: one plugin per line, a leading `*` marks it
 * active, `#` lines are comments, blanks are ignored. Order == load order.
 * BOM-tolerant. Pure.
 */
export function parseGamePluginsTxt(content: string): PluginsTxtEntry[] {
  const out: PluginsTxtEntry[] = []
  // Strip a leading UTF-8 BOM (U+FEFF) via charCodeAt — avoids an irregular-whitespace
  // literal inside a regex, which editors/linters flag (no-irregular-whitespace).
  const noBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  for (const raw of noBom.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const active = line.startsWith('*')
    const name = (active ? line.slice(1) : line).trim()
    if (name) out.push({ name, active })
  }
  return out
}

/** All plugin files (.esp/.esm/.esl) in a directory, case-insensitive, sorted. Empty on any IO error. */
export function scanPluginFiles(dataDir: string): string[] {
  try {
    return readdirSync(dataDir)
      .filter((f) => PLUGIN_EXT.test(f))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  } catch {
    return []
  }
}

/**
 * Merge the plugins.txt order with the files actually on disk into the effective
 * load order. Rules:
 *   1. base masters present on disk come first, active, in canonical order;
 *   2. then plugins.txt entries that exist on disk, in their listed order,
 *      carrying their `*` active flag (masters forced active);
 *   3. then any remaining on-disk plugin not listed in plugins.txt — Skyrim
 *      would not load it, so active=false (except a base master → active).
 * Only files present on disk appear (a stale plugins.txt entry is dropped). Pure.
 */
export function mergeLoadOrder(txtEntries: PluginsTxtEntry[], diskFiles: string[]): LoadOrderEntry[] {
  const diskByLower = new Map<string, string>() // lower → canonical on-disk casing
  for (const f of diskFiles) diskByLower.set(f.toLowerCase(), f)

  const result: { name: string; active: boolean }[] = []
  const seen = new Set<string>()
  const take = (lower: string, active: boolean) => {
    const canonical = diskByLower.get(lower)
    if (!canonical || seen.has(lower)) return
    seen.add(lower)
    result.push({ name: canonical, active })
  }

  // 1. base masters first
  for (const m of BASE_MASTER_ORDER) take(m, true)
  // 2. plugins.txt order (installed only); masters forced active
  for (const e of txtEntries) {
    const lower = e.name.toLowerCase()
    take(lower, BASE_MASTERS.has(lower) ? true : e.active)
  }
  // 3. on-disk plugins not in plugins.txt
  for (const f of diskFiles) {
    const lower = f.toLowerCase()
    take(lower, BASE_MASTERS.has(lower))
  }

  return result.map((e, index) => ({ ...e, index }))
}

export interface LoadOrderSources {
  dataDir: string // Data/ (or the hardlinked-mods folder)
  pluginsTxtPath: string // %LOCALAPPDATA%/Skyrim Special Edition/plugins.txt
}

/**
 * Read the effective load order from local sources. No-throw: a missing/unreadable
 * plugins.txt (Skyrim creates it on first run) yields a disk-only listing rather
 * than an error.
 */
export function getLoadOrder(sources: LoadOrderSources): LoadOrderEntry[] {
  const diskFiles = scanPluginFiles(sources.dataDir)
  let txt: PluginsTxtEntry[] = []
  try {
    if (sources.pluginsTxtPath && existsSync(sources.pluginsTxtPath)) {
      txt = parseGamePluginsTxt(readFileSync(sources.pluginsTxtPath, 'utf8'))
    }
  } catch {
    txt = [] // unreadable → treat as absent
  }
  return mergeLoadOrder(txt, diskFiles)
}

// ── Write path (Milestone 2) ────────────────────────────────────────────────

export interface SaveLoadOrderOptions {
  // Skyrim SE reads plugins.txt as UTF-8 and is written WITHOUT a BOM by the
  // engine and by Mod Organizer 2 — so that is the default. The flag exists only
  // for a hypothetical engine variant that demands a BOM; parse is BOM-tolerant
  // either way, so a round-trip is safe.
  bom?: boolean
}

// SaveLoadOrderResult is single-sourced in src/types (shared API contract).

/**
 * Serialize a load order to Skyrim plugins.txt text: active plugins get a leading
 * `*`, inactive ones just the name, one per line, CRLF-terminated (Windows engine).
 * Entries are emitted in ascending `index` order; names are stripped of any stray
 * line breaks so a bad name can never corrupt the line-based format. Pure.
 */
export function serializePluginsTxt(entries: LoadOrderEntry[], opts: SaveLoadOrderOptions = {}): string {
  const ordered = [...entries].sort((a, b) => a.index - b.index)
  const lines: string[] = []
  for (const e of ordered) {
    const name = e.name.replace(/[\r\n]+/g, '').trim()
    if (name) lines.push((e.active ? '*' : '') + name)
  }
  const body = lines.length ? lines.join('\r\n') + '\r\n' : ''
  return (opts.bom ? String.fromCharCode(0xfeff) : '') + body
}

/**
 * Persist a load order to plugins.txt. Steps, all guarded — a failure returns a
 * Result, never throws into the main process:
 *   1. back up the current plugins.txt to plugins.txt.bak (overwriting a stale one);
 *   2. write the new content to a temp sibling, then rename it over the target
 *      (atomic — a crash mid-write cannot leave a half-written plugins.txt).
 * A missing source file (Skyrim not yet run) just skips the backup and writes fresh.
 */
export function saveLoadOrder(
  entries: LoadOrderEntry[],
  pluginsTxtPath: string,
  opts: SaveLoadOrderOptions = {},
): SaveLoadOrderResult {
  const tmpPath = pluginsTxtPath ? pluginsTxtPath + '.tmp' : ''
  try {
    if (!Array.isArray(entries)) {
      return { success: false, written: 0, backupPath: null, error: 'entries non è un array valido' }
    }
    if (!pluginsTxtPath) {
      return { success: false, written: 0, backupPath: null, error: 'Percorso di plugins.txt non risolto' }
    }

    const content = serializePluginsTxt(entries, opts)

    // 1) Backup the existing file first (overwrite any previous .bak).
    let backupPath: string | null = null
    if (existsSync(pluginsTxtPath)) {
      backupPath = pluginsTxtPath + '.bak'
      copyFileSync(pluginsTxtPath, backupPath)
    }

    // 2) Atomic write: temp file → rename over target.
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, pluginsTxtPath)

    const written = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/).filter((l) => l.length > 0).length
    return { success: true, written, backupPath }
  } catch (e) {
    // Best-effort cleanup of a leftover temp file; never rethrow.
    try {
      if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    return { success: false, written: 0, backupPath: null, error: (e as Error).message }
  }
}
