import type { SqliteDb } from '../db/sqlite'

// Dependency resolver for the reference catalog. Given a set of target nexus_ids
// it walks `requires` transitively, produces a DEPENDENCY-FIRST install order
// (topological), detects cycles (with the offending path) and conflicts, and
// never throws — the whole surface returns an InstallPlanResult.
//
// I/O strategy (avoids N+1): ONE query loads the full catalog graph (just the
// columns the traversal needs) into an in-memory Map; the graph walk then runs
// entirely in TypeScript. For a single-modlist catalog (hundreds to a few
// thousand rows, a few hundred KB) this is one round trip and trivially cheap —
// far simpler to reason about and debug than recursive SQL CTEs. If the catalog
// ever grew to millions of rows, swap loadCatalogGraph for a batched frontier
// (`WHERE nexus_id IN (...)` expanded BFS-style); the pure computeInstallPlan
// core below would stay unchanged.
//
// Cycle safety: the traversal is ITERATIVE (explicit stack, three-color marking)
// so a malicious/broken catalog can neither infinite-loop nor blow the call
// stack — a back-edge to a gray node is reported as a cycle and unwinds.

export interface CatalogNode {
  nexus_id: number
  name: string
  priority_order: number
  requires: number[]
  conflicts_with: number[]
}

export interface PlanItem {
  nexus_id: number
  name: string
  priority_order: number
  reason: 'target' | 'dependency'
}

export interface DependencyConflict {
  mod: number // the mod whose conflicts_with list triggered the conflict
  modName: string
  conflictsWith: number // the offending nexus_id it collides with
  offender: 'installed' | 'planned' // where the offending id already lives
}

export type ResolveErrorKind = 'missing' | 'cycle' | 'conflict' | 'db'

export interface InstallPlanResult {
  success: boolean
  plan?: PlanItem[] // dependency-first (topologically sorted) order
  errorKind?: ResolveErrorKind
  errors?: string[]
  cyclePath?: number[] // e.g. [A, B, C, A] — first === last is the closing edge
  conflicts?: DependencyConflict[]
  // Auto-resolved file-override collisions from the deploy planner (category/weight/
  // priority). Surfaced here so the UI can list the system's choices; the dependency
  // resolver itself leaves it undefined (it reasons over the requires graph, not files).
  resolvedConflicts?: { file: string; winner: string; loser: string }[]
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

function parseIdArray(raw: unknown): number[] {
  if (typeof raw !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const v of parsed) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

interface CatalogRow {
  nexus_id: number | null
  name: string | null
  priority_order: number | null
  requires: string | null
  conflicts_with: string | null
}

/** Single query → in-memory graph (nexus_id → node). No N+1, no recursive SQL. */
export function loadCatalogGraph(db: SqliteDb): Map<number, CatalogNode> {
  const rows = db
    .prepare('SELECT nexus_id, name, priority_order, requires, conflicts_with FROM modlist_catalog')
    .all() as CatalogRow[]
  const graph = new Map<number, CatalogNode>()
  for (const r of rows) {
    if (!Number.isInteger(r.nexus_id) || (r.nexus_id as number) <= 0) continue // skip rows without a usable id
    const id = r.nexus_id as number
    graph.set(id, {
      nexus_id: id,
      name: r.name ?? `mod_${id}`,
      priority_order: Number.isInteger(r.priority_order) ? (r.priority_order as number) : 999,
      requires: parseIdArray(r.requires),
      conflicts_with: parseIdArray(r.conflicts_with),
    })
  }
  return graph
}

// ── Pure resolver core (no DB) ───────────────────────────────────────────────

const WHITE = 0
const GRAY = 1
const BLACK = 2

/**
 * Pure graph traversal: dependency-first topological order via iterative DFS
 * with three-color cycle detection. Deterministic — neighbors and targets are
 * visited in ascending priority_order (then nexus_id) so frameworks tend to
 * land first, without ever violating the topological constraint.
 */
export function computeInstallPlan(
  graph: Map<number, CatalogNode>,
  targetNexusIds: number[],
  installedNexusIds: number[],
): InstallPlanResult {
  const installed = new Set(installedNexusIds.filter((n) => Number.isInteger(n)))
  const targets = [...new Set(targetNexusIds.filter((n) => Number.isInteger(n)))]

  const color = new Map<number, number>()
  const order: number[] = [] // BLACK-ing order == dependency-first
  const missing: string[] = []
  const targetSet = new Set(targets)

  const neighborsOf = (id: number): number[] => {
    const node = graph.get(id)
    if (!node) return []
    // Sort deps by (priority_order, nexus_id) for a stable, framework-first walk.
    return [...node.requires].sort((a, b) => {
      const pa = graph.get(a)?.priority_order ?? 999
      const pb = graph.get(b)?.priority_order ?? 999
      return pa - pb || a - b
    })
  }

  // Targets themselves visited framework-first for deterministic sibling order.
  const sortedTargets = [...targets].sort((a, b) => {
    const pa = graph.get(a)?.priority_order ?? 999
    const pb = graph.get(b)?.priority_order ?? 999
    return pa - pb || a - b
  })

  for (const start of sortedTargets) {
    if (installed.has(start)) continue // already installed ⇒ nothing to plan
    if (!graph.has(start)) {
      missing.push(`target ${start} assente dal catalogo`)
      continue
    }
    if (color.get(start) === BLACK) continue // reached as a dependency already

    // Iterative DFS. Each frame tracks its own neighbor cursor.
    const stack: { id: number; deps: number[]; i: number }[] = []
    const push = (id: number) => {
      color.set(id, GRAY)
      stack.push({ id, deps: neighborsOf(id), i: 0 })
    }
    push(start)

    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (frame.i >= frame.deps.length) {
        color.set(frame.id, BLACK)
        order.push(frame.id)
        stack.pop()
        continue
      }
      const dep = frame.deps[frame.i++]
      if (installed.has(dep)) continue // dependency already satisfied on disk
      if (!graph.has(dep)) {
        missing.push(`mod ${frame.id} richiede ${dep}, assente dal catalogo`)
        continue
      }
      const c = color.get(dep) ?? WHITE
      if (c === GRAY) {
        // Back-edge ⇒ cycle. The gray frames on the stack, from `dep` to the
        // top, are the loop; close it by repeating `dep`.
        const ids = stack.map((f) => f.id)
        const from = ids.indexOf(dep)
        const cyclePath = [...ids.slice(from), dep]
        return {
          success: false,
          errorKind: 'cycle',
          errors: [`ciclo di dipendenze: ${cyclePath.join(' -> ')}`],
          cyclePath,
        }
      }
      if (c === BLACK) continue // already fully placed
      push(dep)
    }
  }

  if (missing.length) {
    return { success: false, errorKind: 'missing', errors: [...new Set(missing)] }
  }

  // ── Conflict pass ──────────────────────────────────────────────────────────
  // A planned/target mod must not declare (in conflicts_with) any nexus_id that
  // is already installed OR is itself being added in this same plan.
  const plannedSet = new Set(order)
  const conflicts: DependencyConflict[] = []
  const seenConflict = new Set<string>()
  for (const id of order) {
    const node = graph.get(id)!
    for (const c of node.conflicts_with) {
      const offender: 'installed' | 'planned' | null = installed.has(c)
        ? 'installed'
        : plannedSet.has(c)
          ? 'planned'
          : null
      if (!offender) continue
      const key = `${id}:${c}`
      if (seenConflict.has(key)) continue
      seenConflict.add(key)
      conflicts.push({ mod: id, modName: node.name, conflictsWith: c, offender })
    }
  }
  if (conflicts.length) {
    return {
      success: false,
      errorKind: 'conflict',
      errors: conflicts.map(
        (k) =>
          `conflitto: ${k.modName} (${k.mod}) è incompatibile con ${k.conflictsWith} ` +
          `(${k.offender === 'installed' ? 'già installato' : 'aggiunto in questo piano'})`,
      ),
      conflicts,
    }
  }

  const plan: PlanItem[] = order.map((id) => {
    const node = graph.get(id)!
    return {
      nexus_id: id,
      name: node.name,
      priority_order: node.priority_order,
      reason: targetSet.has(id) ? 'target' : 'dependency',
    }
  })
  return { success: true, plan }
}

// ── DB-backed entry point (no-throw boundary) ────────────────────────────────

export function resolveInstallPlan(
  db: SqliteDb,
  targetNexusIds: number[],
  installedNexusIds: number[],
): InstallPlanResult {
  let graph: Map<number, CatalogNode>
  try {
    graph = loadCatalogGraph(db)
  } catch (e) {
    return { success: false, errorKind: 'db', errors: [(e as Error).message] }
  }
  try {
    return computeInstallPlan(graph, targetNexusIds, installedNexusIds)
  } catch (e) {
    // The core is pure and should not throw; this is defense-in-depth so an
    // unexpected failure still returns a Result rather than crossing the boundary.
    return { success: false, errorKind: 'db', errors: [(e as Error).message] }
  }
}
