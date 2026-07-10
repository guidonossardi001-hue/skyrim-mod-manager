// PURE deploy planner — no fs, no db. Given the enabled mods (each with its
// Data-relative file list, in priority order) it computes the deterministic
// override map, the junction/hardlink split, and the plugin load order. Testable
// in isolation exactly like planStockGame / planRecipe.
//
// Override rule (MO2/Nolvus): mods are applied in ascending priority; a file from
// a HIGHER-priority mod overrides the same destination path from a lower one — the
// last writer into the map wins. The final map is then split:
//   • a directory whose ENTIRE subtree in the final map is provided by a single mod
//     becomes ONE junction (avoids 100k individual hardlinks for a texture pack),
//   • every other file is an individual hardlink,
//   • root-level plugins (.esp/.esm/.esl) drive plugins.txt.

// Asset class used by the automatic conflict resolver (Nolvus-style, but the
// system decides for the user). A 'patch' always overrides plain assets; the
// other classes only matter for tie-breaks and debug labelling.
export type DeployCategory = 'patch' | 'gameplay' | 'texture' | 'mesh' | 'misc'

export interface DeployMod {
  name: string
  priority: number
  rootDir: string // absolute path of the deployed mod folder (Data-relative tree inside)
  files: string[] // Data-relative POSIX paths this mod provides
  category?: DeployCategory // asset class for auto-resolution (default 'misc')
  resolutionWeight?: number // e.g. 4K=4000, 2K=2000; higher wins a same-class tie (default 0)
}

export interface JunctionLink {
  dir: string // Data-relative directory to junction
  src: string // absolute source (rootDir/dir)
  mod: string // providing mod name
}

export interface HardLink {
  rel: string // Data-relative destination
  src: string // absolute source file
  mod: string
}

export type PluginType = 'ESM' | 'ESL' | 'ESP'

export interface PluginEntry {
  name: string
  type: PluginType
  mod: string
  priority: number
}

// One auto-resolved file collision: two+ mods wrote the same destination, the
// resolver picked `winner` by the category/weight/priority rules and dropped
// `loser`. Purely informational — the deploy proceeds without asking the user.
export interface ResolvedConflict {
  file: string // canonical Data-relative path both mods provided
  winner: string // providing mod that owns the final file
  loser: string // overridden mod for this file
}

export interface DeployPlan {
  junctions: JunctionLink[]
  hardlinks: HardLink[]
  plugins: PluginEntry[]
  resolvedConflicts: ResolvedConflict[] // debug log of auto-resolved overrides
}

// Higher rank wins the category rule. A 'patch' beats every plain asset; the
// rest are ordered so mixed-class collisions still resolve deterministically.
const CATEGORY_RANK: Record<DeployCategory, number> = {
  patch: 4,
  gameplay: 3,
  mesh: 2,
  texture: 1,
  misc: 0,
}

// Valid deploy categories, DERIVED from CATEGORY_RANK so the set can never drift
// from the ranked union: adding a category to the rank automatically admits it here.
const DEPLOY_CATEGORIES = new Set(Object.keys(CATEGORY_RANK))

/** Narrow an untrusted DB string to a DeployCategory, else undefined (→ 'misc'). */
export function toDeployCategory(v: unknown): DeployCategory | undefined {
  return typeof v === 'string' && DEPLOY_CATEGORIES.has(v) ? (v as DeployCategory) : undefined
}

// Automatic winner between two mods that write the SAME destination file:
//   Rule 1 (category): higher CATEGORY_RANK wins — a patch always beats a texture.
//   Rule 2 (weight):   same class → higher resolutionWeight wins (4K over 2K).
//   Rule 3 (priority): same weight → higher priority_order wins (standard MO2).
//   Final tie-break by name so the plan is stable regardless of input order.
function conflictWinner(a: DeployMod, b: DeployMod): DeployMod {
  const ra = CATEGORY_RANK[a.category ?? 'misc']
  const rb = CATEGORY_RANK[b.category ?? 'misc']
  if (ra !== rb) return ra > rb ? a : b
  const wa = a.resolutionWeight ?? 0
  const wb = b.resolutionWeight ?? 0
  if (wa !== wb) return wa > wb ? a : b
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b
  return a.name.localeCompare(b.name) >= 0 ? a : b
}

function normRel(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function parentDir(d: string): string {
  const i = d.lastIndexOf('/')
  return i === -1 ? '' : d.slice(0, i)
}

function pluginType(name: string): PluginType | null {
  const m = name.toLowerCase().match(/\.(esm|esl|esp)$/)
  if (!m) return null
  return m[1] === 'esm' ? 'ESM' : m[1] === 'esl' ? 'ESL' : 'ESP'
}

export function computeDeployPlan(mods: DeployMod[]): DeployPlan {
  // Deterministic base order (ascending priority, name tie-break) so candidate
  // lists — and therefore the resolved-conflict log — are stable across input order.
  const ordered = [...mods].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))

  // Every mod that writes each destination key (lowercased destRel → candidates).
  // Canonical (original-case) path is carried per candidate so emitted paths keep
  // the WINNER's source casing.
  interface Candidate {
    mod: DeployMod
    rel: string
    src: string
  }
  const candidates = new Map<string, Candidate[]>()
  for (const mod of ordered) {
    for (const f of mod.files) {
      const rel = normRel(f)
      if (!rel) continue
      const key = rel.toLowerCase()
      let arr = candidates.get(key)
      if (!arr) candidates.set(key, (arr = []))
      // A mod listing the same file twice contributes a single candidate.
      if (!arr.some((c) => c.mod === mod)) arr.push({ mod, rel, src: `${mod.rootDir}/${rel}` })
    }
  }

  // Resolve each destination to ONE winner via the category/weight/priority rules,
  // recording every override we auto-resolved so the user can audit the choices.
  const provider = new Map<string, DeployMod>()
  const srcOf = new Map<string, string>()
  const canon = new Map<string, string>()
  const resolvedConflicts: ResolvedConflict[] = []
  for (const [key, arr] of candidates) {
    let win = arr[0]
    for (let i = 1; i < arr.length; i++) {
      if (conflictWinner(win.mod, arr[i].mod) !== win.mod) win = arr[i]
    }
    provider.set(key, win.mod)
    srcOf.set(key, win.src)
    canon.set(key, win.rel)
    if (arr.length > 1) {
      for (const c of arr) {
        if (c.mod !== win.mod)
          resolvedConflicts.push({ file: win.rel, winner: win.mod.name, loser: c.mod.name })
      }
    }
  }

  // Provider set for every ancestor directory of every final file. A directory
  // owned by exactly one mod is a junction candidate.
  const dirProviders = new Map<string, Set<DeployMod>>()
  for (const key of provider.keys()) {
    const rel = canon.get(key)!
    const mod = provider.get(key)!
    const segs = rel.split('/')
    for (let i = 0; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/') // '' = root, then each ancestor dir
      let set = dirProviders.get(dir)
      if (!set) dirProviders.set(dir, (set = new Set()))
      set.add(mod)
    }
  }

  // Pick MAXIMAL single-provider directories: providers(D)==1 and either D is a
  // top-level dir (parent is root) or the parent is mixed (so D is the largest
  // conflict-free subtree). Shallowest-first so nested dirs are skipped once an
  // ancestor is junctioned.
  const junctions: JunctionLink[] = []
  const junctionDirs: string[] = []
  const underJunction = (path: string) =>
    junctionDirs.some((j) => path === j || path.startsWith(j + '/'))
  const dirsByDepth = [...dirProviders.keys()]
    .filter((d) => d !== '')
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  for (const dir of dirsByDepth) {
    if (underJunction(dir)) continue
    const set = dirProviders.get(dir)!
    if (set.size !== 1) continue
    const parent = parentDir(dir)
    const parentMixed = parent === '' || (dirProviders.get(parent)?.size ?? 0) > 1
    if (!parentMixed) continue
    const mod = [...set][0]
    junctions.push({ dir, src: `${mod.rootDir}/${dir}`, mod: mod.name })
    junctionDirs.push(dir)
  }

  // Everything not covered by a junction is an individual hardlink.
  const hardlinks: HardLink[] = []
  const plugins: PluginEntry[] = []
  for (const key of provider.keys()) {
    const rel = canon.get(key)!
    const mod = provider.get(key)!
    const dir = parentDir(rel)
    if (!underJunction(dir === '' ? rel : dir)) {
      hardlinks.push({ rel, src: srcOf.get(key)!, mod: mod.name })
    }
    // Plugins live at the Data root (no directory component).
    if (dir === '') {
      const t = pluginType(rel)
      if (t) plugins.push({ name: rel, type: t, mod: mod.name, priority: mod.priority })
    }
  }

  // Stable ordering for deterministic output.
  hardlinks.sort((a, b) => a.rel.localeCompare(b.rel))
  junctions.sort((a, b) => a.dir.localeCompare(b.dir))
  resolvedConflicts.sort((a, b) => a.file.localeCompare(b.file) || a.loser.localeCompare(b.loser))
  return { junctions, hardlinks, plugins, resolvedConflicts }
}

const TYPE_RANK: Record<PluginType, number> = { ESM: 0, ESL: 1, ESP: 2 }

// Base-game masters always load first (they live in the read-only StockGame Data,
// not in any mod folder, so they are prepended here for a complete load order).
export const BASE_MASTERS = [
  'Skyrim.esm',
  'Update.esm',
  'Dawnguard.esm',
  'HearthFires.esm',
  'Dragonborn.esm',
]

/**
 * Deterministic plugins.txt: base masters first (unprefixed, implicitly active), then
 * the Creation Club "System DLC" block (forced right after the official DLCs, in
 * Bethesda load order), then mod plugins (ESM → ESL → ESP, by providing-mod priority).
 * CC and mod plugins are prefixed with '*' (active). A mod plugin whose name matches a
 * base master or a CC plugin is de-duplicated (the CC/master slot wins its position).
 */
export function buildPluginsTxt(plugins: PluginEntry[], ccPlugins: string[] = []): string {
  const seen = new Set(BASE_MASTERS.map((m) => m.toLowerCase()))
  // CC block: system DLC, forced immediately after the base masters in the given order.
  const cc: string[] = []
  for (const name of ccPlugins) {
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    cc.push(name)
  }
  const ordered = [...plugins]
    .filter((p) => {
      const k = p.name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort(
      (a, b) =>
        TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
        a.priority - b.priority ||
        a.mod.localeCompare(b.mod) ||
        a.name.localeCompare(b.name),
    )
  const lines = [
    '# Generated by Skyrim Mod Manager — do not edit by hand',
    ...BASE_MASTERS,
    ...cc.map((n) => `*${n}`),
    ...ordered.map((p) => `*${p.name}`),
  ]
  return lines.join('\n') + '\n'
}
