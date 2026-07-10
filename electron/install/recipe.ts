// PURE recipe planner — the deterministic replacement for FOMOD ModuleConfig.xml
// logic. Given the flat list of paths an archive extracted to, plus a signed
// InstallInstructions, it computes the {src → destRel} placement plan the atomic
// installer will apply. NO I/O, NO fs/child_process: string logic only, so the
// whole FOMOD-replacement policy is unit-testable with mock listings (same shape
// as planStockGame / computeInstallPlan). No-throw boundary: always a Result.
//
// Semantics under strategy 'recipe':
//   • a file is DROPPED unless an `include`/`rename` rule matches it (implicit drop),
//   • rules apply in order; a later matching rule overrides an earlier one for the
//     same file (so include→exclude excludes, and two includes → the later wins),
//   • when two DIFFERENT files land on the same destRel, the one selected by the
//     later rule wins (FOMOD "option folder overwrites core" behaviour),
//   • every destRel is checked for recipe-slip (must resolve inside the mod root),
//   • post-conditions (minFiles / mustContain) gate the plan — a recipe that picks
//     nothing, or misses a declared vital file, fails instead of deploying junk.
// Matching is case-insensitive (Windows/NTFS reality; FOMOD folder casing varies)
// while original casing is preserved in the emitted paths.

export type MatchType = 'exact' | 'prefix' | 'glob'

export interface RecipeRule {
  op: 'include' | 'exclude' | 'rename'
  match: string // path/pattern relative to archiveRoot (POSIX, forward slashes)
  matchType?: MatchType // default 'prefix' for include/exclude, 'exact' for rename
  dest?: string // include: remap the matched subtree under this dest prefix
  stripPrefix?: boolean // include: drop the matched prefix ("00 Core/x" → "x")
  to?: string // rename: the new dest-relative path for the matched file
}

export interface InstallInstructions {
  schema_version: number
  strategy: 'root' | 'recipe' // 'root' = flatten whole archive (default, back-compat)
  archiveRoot?: string // where the mod's real tree starts inside the archive
  rules?: RecipeRule[] // required for 'recipe'; ignored for 'root'
  expect?: {
    minFiles?: number
    mustContain?: string[] // dest-relative paths that MUST exist after applying
  }
}

export interface RecipeMapping {
  src: string // original archive-relative path (unmodified — the installer reads this)
  destRel: string // normalized, mod-root-relative destination (forward slashes)
}

export type RecipeErrorKind = 'recipe-slip' | 'empty' | 'expect' | 'invalid'

export interface RecipePlanResult {
  success: boolean
  mappings?: RecipeMapping[]
  errorKind?: RecipeErrorKind
  errors?: string[]
}

const fail = (errorKind: RecipeErrorKind, errors: string[]): RecipePlanResult => ({
  success: false,
  errorKind,
  errors,
})

// ── Path helpers (pure) ──────────────────────────────────────────────────────

function normSlashes(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
}

function stripEdgeSlashes(p: string): string {
  return normSlashes(p)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/**
 * Resolve a candidate destination to a clean mod-root-relative path, or flag it
 * as a recipe-slip. Blocks absolute paths, drive letters, UNC, and any `..` that
 * escapes the root; collapses harmless `.`/`..` that stay inside.
 */
export function resolveRel(p: string): { path: string; slip: boolean } {
  const raw = normSlashes(p).trim()
  if (raw === '') return { path: '', slip: true }
  if (/^[A-Za-z]:(\/|$)/.test(raw)) return { path: '', slip: true } // drive-letter absolute
  if (raw.startsWith('/')) return { path: '', slip: true } // POSIX-absolute or (collapsed) UNC

  const stack: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) return { path: '', slip: true } // escapes the root
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  if (stack.length === 0) return { path: '', slip: true } // resolved to the root itself — no file
  return { path: stack.join('/'), slip: false }
}

// ── Matching (pure) ──────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*' // ** crosses directory separators
        i++
        if (glob[i + 1] === '/') i++ // swallow the slash after ** so "**/x" also matches "x"
      } else {
        re += '[^/]*' // * stays within a single segment
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + re + '$')
}

function matchTypeOf(rule: RecipeRule): MatchType {
  return rule.matchType ?? (rule.op === 'rename' ? 'exact' : 'prefix')
}

/** rel is archiveRoot-relative. Case-insensitive (Windows FS reality). */
function ruleMatches(rel: string, rule: RecipeRule): boolean {
  const type = matchTypeOf(rule)
  const m = stripEdgeSlashes(rule.match).toLowerCase()
  const r = rel.toLowerCase()
  if (type === 'exact') return r === m
  if (type === 'prefix') return r === m || r.startsWith(m + '/')
  return globToRegex(m).test(r)
}

/** The literal directory prefix that stripPrefix removes for a given rule. */
function staticPrefix(rule: RecipeRule): string {
  const match = stripEdgeSlashes(rule.match)
  if (matchTypeOf(rule) === 'glob') {
    const wild = match.search(/[*?]/)
    const lit = wild === -1 ? match : match.slice(0, wild)
    const slash = lit.lastIndexOf('/')
    return slash === -1 ? '' : lit.slice(0, slash)
  }
  return match // exact / prefix: the whole literal path
}

/** Compute the (pre-slip-check) destination for a file selected by a winning rule. */
function destFor(rel: string, rule: RecipeRule): string {
  if (rule.op === 'rename') return stripEdgeSlashes(rule.to ?? '')

  let tail = rel
  if (rule.stripPrefix) {
    const prefix = staticPrefix(rule)
    const pl = prefix.toLowerCase()
    const rl = rel.toLowerCase()
    if (prefix && rl === pl) {
      tail = rel.split('/').pop() ?? rel // file equals the prefix → keep its basename
    } else if (prefix && rl.startsWith(pl + '/')) {
      tail = rel.slice(prefix.length + 1)
    }
    // prefix doesn't cleanly apply (e.g. glob with no static dir) → leave tail as rel
  }
  const dest = rule.dest ? stripEdgeSlashes(rule.dest) : ''
  return dest ? dest + '/' + tail : tail
}

// ── Planner ──────────────────────────────────────────────────────────────────

/**
 * 7-Zip include patterns (archive-relative, POSIX) for a recipe, so extraction can
 * skip subtrees we already know we'll drop. Derived from include/rename rules only;
 * excludes are applied post-extraction by planRecipe. Empty ⇒ extract everything.
 * OPTIMIZATION ONLY: these can only ever be a SUPERSET of what planRecipe keeps,
 * never fewer files, so a wrong/empty filter set safely degrades to a full extract.
 */
export function sevenZipIncludeFilters(instructions: InstallInstructions): string[] {
  if (!instructions || instructions.strategy !== 'recipe' || !Array.isArray(instructions.rules)) return []
  const root = stripEdgeSlashes(instructions.archiveRoot ?? '')
  const pats = new Set<string>()
  for (const rule of instructions.rules) {
    if (rule.op === 'exclude') continue
    const m = stripEdgeSlashes(rule.match)
    if (!m) continue
    pats.add(root ? `${root}/${m}` : m)
  }
  return [...pats]
}

export function planRecipe(files: string[], instructions: InstallInstructions): RecipePlanResult {
  try {
    if (!instructions || typeof instructions !== 'object') return fail('invalid', ['instructions assenti'])
    const strategy = instructions.strategy
    if (strategy !== 'root' && strategy !== 'recipe')
      return fail('invalid', [`strategy non valida: ${String(strategy)}`])
    if (!Array.isArray(files)) return fail('invalid', ['lista file non valida'])

    // archiveRoot-relative view; files outside archiveRoot are dropped up front.
    const archiveRoot = stripEdgeSlashes(instructions.archiveRoot ?? '')
    const rootLower = archiveRoot.toLowerCase()
    const view: { src: string; rel: string }[] = []
    for (const f of files) {
      const nf = stripEdgeSlashes(f)
      if (nf === '') continue
      if (archiveRoot) {
        const lower = nf.toLowerCase()
        if (lower === rootLower) continue // the root dir entry itself
        if (!lower.startsWith(rootLower + '/')) continue // outside the mod tree
        view.push({ src: f, rel: nf.slice(archiveRoot.length + 1) })
      } else {
        view.push({ src: f, rel: nf })
      }
    }

    // Selection.
    const chosen: { src: string; destRel: string; ruleIdx: number }[] = []
    if (strategy === 'root') {
      for (const v of view) chosen.push({ src: v.src, destRel: v.rel, ruleIdx: 0 })
    } else {
      const rules = Array.isArray(instructions.rules) ? instructions.rules : []
      if (rules.length === 0) return fail('invalid', ['strategy "recipe" senza regole'])
      for (const v of view) {
        let included = false
        let destRel = v.rel
        let winIdx = -1
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]
          if (!ruleMatches(v.rel, rule)) continue
          if (rule.op === 'exclude') {
            included = false
            continue
          }
          included = true // include | rename — a later match overrides an earlier one
          winIdx = i
          destRel = destFor(v.rel, rule)
        }
        if (included) chosen.push({ src: v.src, destRel, ruleIdx: winIdx })
      }
    }

    // Recipe-slip guard + normalize every destination. One bad path fails the whole plan.
    const resolved: { src: string; destRel: string; ruleIdx: number }[] = []
    for (const c of chosen) {
      const r = resolveRel(c.destRel)
      if (r.slip)
        return fail('recipe-slip', [`destinazione non sicura (recipe-slip): "${c.destRel}" da ${c.src}`])
      resolved.push({ src: c.src, destRel: r.path, ruleIdx: c.ruleIdx })
    }

    // Overwrite resolution: higher ruleIdx wins a dest collision; equal idx → later file wins.
    const byDest = new Map<string, { src: string; destRel: string; ruleIdx: number }>()
    for (const r of resolved) {
      const key = r.destRel.toLowerCase()
      const ex = byDest.get(key)
      if (!ex || ex.ruleIdx <= r.ruleIdx) byDest.set(key, r)
    }
    const mappings: RecipeMapping[] = [...byDest.values()]
      .sort((a, b) => a.destRel.localeCompare(b.destRel))
      .map((m) => ({ src: m.src, destRel: m.destRel }))

    // Post-conditions.
    if (mappings.length === 0) return fail('empty', ['la recipe non seleziona alcun file'])
    const expect = instructions.expect
    if (expect?.minFiles != null && mappings.length < expect.minFiles)
      return fail('expect', [`attesi almeno ${expect.minFiles} file, prodotti ${mappings.length}`])
    if (expect?.mustContain?.length) {
      const present = new Set(mappings.map((m) => m.destRel.toLowerCase()))
      const missing = expect.mustContain
        .map((p) => resolveRel(p).path)
        .filter((p) => p === '' || !present.has(p.toLowerCase()))
      if (missing.length)
        return fail(
          'expect',
          missing.map((p) => `file richiesto assente dal piano: ${p || '(path non valido)'}`),
        )
    }

    return { success: true, mappings }
  } catch (e) {
    // Pure code shouldn't throw; defense-in-depth keeps the no-throw contract.
    return fail('invalid', [(e as Error).message])
  }
}
