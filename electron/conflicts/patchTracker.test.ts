import { describe, it, expect } from 'vitest'
import { openTestDb } from '../db/openTestDb'
import type { ConflictEntry, ConflictParticipant } from './conflictIndex'
import { trackConflicts, classifyConflict, loadIgnoredKeys, setIgnored } from './patchTracker'

const PATCH = 'fantasylauncher_output.esp'

const part = (plugin: string, orderIdx: number, dataCrc: number, isOwn = false): ConflictParticipant => ({
  plugin,
  displayName: plugin,
  orderIdx,
  dataCrc,
  isOwn,
})
const entry = (
  formKey: string,
  participants: ConflictParticipant[],
  identicalOverrides = false,
): ConflictEntry => ({
  formKey,
  signature: 'WEAP',
  edid: null,
  participants,
  identicalOverrides,
})

describe('classifyConflict', () => {
  it('resolved: la patch overrida ED è ultima nel load order', () => {
    const c = entry('base.esm|000001', [
      part('base.esm', 0, 1, true),
      part('a.esp', 1, 2),
      part('b.esp', 2, 3),
      part(PATCH, 3, 9),
    ])
    expect(classifyConflict(c, PATCH, new Set())).toEqual({ status: 'resolved', winner: PATCH })
  })

  it('shadowed: la patch overrida ma un plugin carica DOPO e vince lui', () => {
    const c = entry('base.esm|000001', [
      part('base.esm', 0, 1, true),
      part('a.esp', 1, 2),
      part(PATCH, 2, 9),
      part('late.esp', 3, 4),
    ])
    expect(classifyConflict(c, PATCH, new Set())).toEqual({ status: 'shadowed', winner: 'late.esp' })
  })

  it('identical: override tutti uguali, nessuna scelta da fare', () => {
    const c = entry(
      'base.esm|000002',
      [part('base.esm', 0, 1, true), part('a.esp', 1, 7), part('b.esp', 2, 7)],
      true,
    )
    expect(classifyConflict(c, PATCH, new Set()).status).toBe('identical')
  })

  it('unresolved: conflitto reale non coperto dalla patch', () => {
    const c = entry('base.esm|000003', [
      part('base.esm', 0, 1, true),
      part('a.esp', 1, 2),
      part('b.esp', 2, 3),
    ])
    expect(classifyConflict(c, PATCH, new Set()).status).toBe('unresolved')
  })

  it('ignored vince su tutto (anche su resolved)', () => {
    const c = entry('base.esm|000001', [part('a.esp', 1, 2), part(PATCH, 3, 9)])
    expect(classifyConflict(c, PATCH, new Set(['base.esm|000001'])).status).toBe('ignored')
  })
})

describe('trackConflicts', () => {
  it('riepilogo per stato + match case-insensitive del nome patch', () => {
    const conflicts = [
      entry('k1', [part('a.esp', 1, 2), part(PATCH, 2, 9)]),
      entry('k2', [part('a.esp', 1, 7), part('b.esp', 2, 7)], true),
      entry('k3', [part('a.esp', 1, 2), part('b.esp', 2, 3)]),
    ]
    const { items, summary } = trackConflicts(conflicts, { patchName: 'FantasyLauncher_Output.ESP' })
    expect(items.map((i) => i.status)).toEqual(['resolved', 'identical', 'unresolved'])
    expect(summary.total).toBe(3)
    expect(summary.byStatus).toEqual({ ignored: 0, resolved: 1, shadowed: 0, identical: 1, unresolved: 1 })
  })
})

describe('persistenza ignore', () => {
  it('setIgnored/loadIgnoredKeys roundtrip, rimozione inclusa', () => {
    const db = openTestDb()
    setIgnored(db, 'base.esm|000001', true, 'falso positivo LOD')
    setIgnored(db, 'base.esm|000002', true)
    expect(loadIgnoredKeys(db)).toEqual(new Set(['base.esm|000001', 'base.esm|000002']))
    setIgnored(db, 'base.esm|000001', false)
    expect(loadIgnoredKeys(db)).toEqual(new Set(['base.esm|000002']))
  })
})
