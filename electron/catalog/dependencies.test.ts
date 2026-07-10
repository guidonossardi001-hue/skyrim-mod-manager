import { describe, it, expect, beforeEach } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { resolveInstallPlan } from './dependencies'

// In-memory node:sqlite (same "mock DB" the rest of the suite uses via openTestDb).
// Exercising the real SQL + JSON-column round trip is stronger than a canned mock:
// it proves requires/conflicts_with are parsed from the actual stored format.

interface SeedMod {
  nexus_id: number
  name?: string
  priority_order?: number
  requires?: number[]
  conflicts_with?: number[]
}

function testDb(): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`
    CREATE TABLE modlist_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nexus_id INTEGER UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      priority_order INTEGER DEFAULT 999,
      requires TEXT DEFAULT '[]',
      conflicts_with TEXT DEFAULT '[]'
    );
  `)
  return db
}

function seed(db: SqliteDb, mods: SeedMod[]): void {
  const ins = db.prepare(
    'INSERT INTO modlist_catalog (nexus_id, name, priority_order, requires, conflicts_with) VALUES (?,?,?,?,?)',
  )
  for (const m of mods) {
    ins.run(
      m.nexus_id,
      m.name ?? `mod_${m.nexus_id}`,
      m.priority_order ?? 999,
      JSON.stringify(m.requires ?? []),
      JSON.stringify(m.conflicts_with ?? []),
    )
  }
}

const ids = (r: { plan?: { nexus_id: number }[] }) => (r.plan ?? []).map((p) => p.nexus_id)
/** index of a nexus_id in the plan (asserts dependency ordering) */
const at = (r: { plan?: { nexus_id: number }[] }, id: number) => ids(r).indexOf(id)

describe('resolveInstallPlan', () => {
  let db: SqliteDb
  beforeEach(() => {
    db = testDb()
  })

  it('happy path: deep chain A→B→C is ordered dependencies-first', () => {
    // A requires B, B requires C
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2] },
      { nexus_id: 2, name: 'B', requires: [3] },
      { nexus_id: 3, name: 'C' },
    ])
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(true)
    expect(ids(r)).toEqual([3, 2, 1]) // C before B before A
    expect(at(r, 3)).toBeLessThan(at(r, 2))
    expect(at(r, 2)).toBeLessThan(at(r, 1))
    const reasons = Object.fromEntries((r.plan ?? []).map((p) => [p.nexus_id, p.reason]))
    expect(reasons[1]).toBe('target')
    expect(reasons[2]).toBe('dependency')
    expect(reasons[3]).toBe('dependency')
  })

  it('deduplication: A requires B & C, C requires B → B appears once, before both', () => {
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2, 3] },
      { nexus_id: 2, name: 'B' },
      { nexus_id: 3, name: 'C', requires: [2] },
    ])
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(true)
    expect(ids(r).filter((x) => x === 2)).toHaveLength(1) // B exactly once
    expect(ids(r)).toHaveLength(3)
    expect(at(r, 2)).toBeLessThan(at(r, 3)) // B before C
    expect(at(r, 3)).toBeLessThan(at(r, 1)) // C before A
  })

  it('cycle: A→B→C→A fails gracefully with the cycle path (no stack overflow)', () => {
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2] },
      { nexus_id: 2, name: 'B', requires: [3] },
      { nexus_id: 3, name: 'C', requires: [1] },
    ])
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('cycle')
    expect(r.cyclePath).toBeDefined()
    const path = r.cyclePath!
    expect(path[0]).toBe(path[path.length - 1]) // closes the loop
    expect(new Set(path)).toEqual(new Set([1, 2, 3])) // all three involved
    expect(path).toHaveLength(4) // [A,B,C,A]
  })

  it('self-cycle: A requires A is detected as a cycle, not silently dropped', () => {
    seed(db, [{ nexus_id: 1, name: 'A', requires: [1] }])
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('cycle')
    expect(r.cyclePath).toEqual([1, 1])
  })

  it('conflict: A requires B, B conflicts_with C, C already installed → fails with the exact mod', () => {
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2] },
      { nexus_id: 2, name: 'B', conflicts_with: [3] },
      { nexus_id: 3, name: 'C' },
    ])
    const r = resolveInstallPlan(db, [1], [3]) // C (3) installed
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('conflict')
    expect(r.conflicts).toHaveLength(1)
    const c = r.conflicts![0]
    expect(c.mod).toBe(2)
    expect(c.modName).toBe('B')
    expect(c.conflictsWith).toBe(3)
    expect(c.offender).toBe('installed')
  })

  it('conflict inside the plan itself (offender just added, not pre-installed)', () => {
    // A requires B; A also declares conflicts_with B → B is pulled into the plan
    // as a dependency AND flagged as conflicting → 'planned' offender.
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2], conflicts_with: [2] },
      { nexus_id: 2, name: 'B' },
    ])
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('conflict')
    expect(r.conflicts![0]).toMatchObject({ mod: 1, conflictsWith: 2, offender: 'planned' })
  })

  it('missing dependency: required id absent from the catalog fails with errorKind "missing"', () => {
    seed(db, [{ nexus_id: 1, name: 'A', requires: [999] }])
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('missing')
    expect(r.errors?.some((e) => e.includes('999'))).toBe(true)
  })

  it('missing target: a target absent from the catalog is reported', () => {
    seed(db, [{ nexus_id: 1, name: 'A' }])
    const r = resolveInstallPlan(db, [42], [])
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('missing')
    expect(r.errors?.some((e) => e.includes('42'))).toBe(true)
  })

  it('an installed dependency is treated as satisfied and pruned from the plan', () => {
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2] },
      { nexus_id: 2, name: 'B', requires: [3] },
      { nexus_id: 3, name: 'C' },
    ])
    const r = resolveInstallPlan(db, [1], [2]) // B installed ⇒ its subtree (C) not needed
    expect(r.success).toBe(true)
    expect(ids(r)).toEqual([1]) // only A remains
  })

  it('an already-installed target yields an empty plan (nothing to do)', () => {
    seed(db, [{ nexus_id: 1, name: 'A' }])
    const r = resolveInstallPlan(db, [1], [1])
    expect(r.success).toBe(true)
    expect(ids(r)).toEqual([])
  })

  it('empty targets → success with an empty plan', () => {
    seed(db, [{ nexus_id: 1, name: 'A' }])
    const r = resolveInstallPlan(db, [], [])
    expect(r.success).toBe(true)
    expect(ids(r)).toEqual([])
  })

  it('duplicate + overlapping targets share dependencies without duplication', () => {
    // A→C, B→C. Targets [A,B] (A listed twice). C once, before both A and B.
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [3] },
      { nexus_id: 2, name: 'B', requires: [3] },
      { nexus_id: 3, name: 'C' },
    ])
    const r = resolveInstallPlan(db, [1, 2, 1], [])
    expect(r.success).toBe(true)
    expect(ids(r).filter((x) => x === 3)).toHaveLength(1)
    expect(ids(r)).toHaveLength(3)
    expect(at(r, 3)).toBeLessThan(at(r, 1))
    expect(at(r, 3)).toBeLessThan(at(r, 2))
  })

  it('independent targets are ordered framework-first (lower priority_order wins the tie)', () => {
    seed(db, [
      { nexus_id: 1, name: 'Late', priority_order: 500 },
      { nexus_id: 2, name: 'Framework', priority_order: 10 },
    ])
    const r = resolveInstallPlan(db, [1, 2], [])
    expect(r.success).toBe(true)
    expect(ids(r)).toEqual([2, 1]) // priority 10 before priority 500
  })

  it('cycle is reported even when a conflict also exists (cycle takes precedence)', () => {
    seed(db, [
      { nexus_id: 1, name: 'A', requires: [2], conflicts_with: [9] },
      { nexus_id: 2, name: 'B', requires: [1] },
    ])
    const r = resolveInstallPlan(db, [1], [9])
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('cycle')
  })

  it('malformed JSON in requires is tolerated (treated as no deps), never throws', () => {
    seed(db, [{ nexus_id: 1, name: 'A' }])
    db.prepare('UPDATE modlist_catalog SET requires=? WHERE nexus_id=1').run('{not json')
    const r = resolveInstallPlan(db, [1], [])
    expect(r.success).toBe(true)
    expect(ids(r)).toEqual([1])
  })
})
