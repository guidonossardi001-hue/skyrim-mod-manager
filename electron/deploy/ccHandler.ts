import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { PluginType } from './plan'

// Creation Club (CC) detector. CC content ships in the BASE game's Data folder
// (ccXXX…-Name.esm/.esl + a matching .bsa, plus the AE _ResourcePack bundle). Nolvus
// treats it as a "System DLC": it is hardlinked into every instance and forced into
// the load order right after the official DLCs — never owned by a normal mod.
//
// This module is a PURE, READ-ONLY scanner of StockGame/Data. It never writes and
// never throws: a legacy Skyrim without any CC (or a missing/unreadable Data folder)
// simply yields an empty list (graceful degradation).

// Naming conventions, kept in sync with electron/install/stockGame.ts vanilla patterns.
// Il separatore accetta `-` E `_`: la convenzione Bethesda usa il trattino su ~80 plugin CC
// ma `ccKRTSSE001_Altar.esl` (Saints & Seducers altar) usa l'underscore. Col solo `-` quel
// plugin non veniva riconosciuto come Creation Club → restava fuori dai master disponibili →
// ogni mod che lo richiede veniva bocciata con "master mancante" benché il file fosse lì.
const CC_PLUGIN_RE = /^(cc[a-z0-9]+[-_].+|_resourcepack)\.(esm|esl)$/i
const CC_ARCHIVE_RE = /^(cc[a-z0-9]+[-_].+|_resourcepack|marketplacetextures)\.bsa$/i
const CCC_FILE = 'Skyrim.ccc' // Bethesda's authoritative CC load-order manifest

export interface CCFile {
  rel: string // Data-relative POSIX name (CC content is flat at the Data root)
  src: string // absolute path under StockGame/Data (hardlink source)
}

export interface CCPackage {
  name: string // base name, e.g. 'ccBGSSSE001-Fish'
  plugin: string | null // plugin filename, or null for an archive-only package
  pluginType: PluginType | null
  files: CCFile[] // every file in the package (plugin + archive(s))
}

function pluginTypeOf(name: string): PluginType | null {
  const m = name.toLowerCase().match(/\.(esm|esl)$/)
  return m ? (m[1] === 'esm' ? 'ESM' : 'ESL') : null
}

/** Parse Skyrim.ccc (plugin filename per line) into filename→load-order index. */
function readCccOrder(dataDir: string): Map<string, number> {
  const order = new Map<string, number>()
  // The manifest lives at the Data root in this project's StockGame layout; also try
  // the parent (game root) where a real Skyrim keeps it, for robustness.
  for (const candidate of [join(dataDir, CCC_FILE), join(dataDir, '..', CCC_FILE)]) {
    try {
      if (!existsSync(candidate)) continue
      let i = 0
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        if (!order.has(line.toLowerCase())) order.set(line.toLowerCase(), i++)
      }
      break // first manifest found wins
    } catch {
      /* unreadable → try next / fall through to empty */
    }
  }
  return order
}

/**
 * Scan StockGame/Data for Creation Club content, grouped into packages and ordered
 * by Bethesda's natural load order (Skyrim.ccc when present, else alphabetical).
 * Never throws; returns [] for a legacy/CC-less or missing Data folder.
 */
export function detectCreationClub(stockGameDataDir?: string): CCPackage[] {
  if (!stockGameDataDir) return []
  let entries: string[]
  try {
    if (!existsSync(stockGameDataDir)) return []
    entries = readdirSync(stockGameDataDir)
  } catch {
    return [] // unreadable Data folder → graceful empty
  }

  // Skyrim.ccc è il manifest UFFICIALE di Bethesda dei CC posseduti: usarlo come fonte di
  // verità rende il riconoscimento immune a ogni futura eccezione di naming (il regex resta
  // come fallback per una Data senza .ccc). L'intersezione con `entries` è implicita: il
  // loop parte dai file realmente presenti, quindi un .ccc che elenca CC non installati
  // non può inventare pacchetti.
  const ccc = readCccOrder(stockGameDataDir)
  const isCccPlugin = (name: string) => ccc.has(name.toLowerCase())

  const byBase = new Map<string, CCPackage>()
  const baseNameOf = (file: string) => file.replace(/\.(esm|esl|bsa)$/i, '')
  const pkgFor = (base: string): CCPackage => {
    const key = base.toLowerCase()
    let p = byBase.get(key)
    if (!p) byBase.set(key, (p = { name: base, plugin: null, pluginType: null, files: [] }))
    return p
  }

  for (const name of entries) {
    // Plugin: dichiarato nel .ccc di Bethesda OPPURE conforme alla convenzione di naming.
    const isPlugin = isCccPlugin(name) ? /\.(esm|esl)$/i.test(name) : CC_PLUGIN_RE.test(name)
    if (!isPlugin && !CC_ARCHIVE_RE.test(name)) continue // not CC content
    const p = pkgFor(baseNameOf(name))
    p.files.push({ rel: name, src: join(stockGameDataDir, name) })
    if (isPlugin) {
      p.plugin = name
      p.pluginType = pluginTypeOf(name)
    }
  }
  if (byBase.size === 0) return []

  // Deterministic file order within each package (plugin-agnostic, by name).
  for (const p of byBase.values()) p.files.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()))

  // Order packages by their plugin's position in Skyrim.ccc (già letto sopra); unlisted /
  // archive-only packages follow alphabetically. This preserves Bethesda's intended order.
  const idx = (p: CCPackage) => (p.plugin ? (ccc.get(p.plugin.toLowerCase()) ?? Infinity) : Infinity)
  return [...byBase.values()].sort(
    (a, b) => idx(a) - idx(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
}

/** Every CC file to hardlink, flattened in package (load) order. */
export function ccFiles(packages: CCPackage[]): CCFile[] {
  return packages.flatMap((p) => p.files)
}

/** CC plugin filenames in load order (packages without a plugin are skipped). */
export function ccPluginOrder(packages: CCPackage[]): string[] {
  return packages.map((p) => p.plugin).filter((n): n is string => n != null)
}
