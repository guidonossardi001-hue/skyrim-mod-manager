import { describe, it, expect } from 'vitest'
import { lootSort, type LootPlugin } from './lootSort'

const P = (
  name: string,
  priority: number,
  over: Partial<LootPlugin> = {},
): LootPlugin => ({
  name,
  priority,
  masterSpace: /\.(esm|esl)$/i.test(name),
  masters: [],
  ...over,
})

describe('lootSort', () => {
  it('spazio master prima dei regular, stabile su (priority, nome)', () => {
    const r = lootSort([
      P('Zeta.esp', 1),
      P('Alpha.esp', 2),
      P('Core.esm', 9),
      P('Tiny.esl', 5),
    ])
    expect(r.ok && r.order).toEqual(['Tiny.esl', 'Core.esm', 'Zeta.esp', 'Alpha.esp'])
  })

  it('ordina topologicamente sui master REALI dell’header (case-insensitive)', () => {
    const r = lootSort([
      P('Quest.esp', 1, { masters: ['LIB.ESP'] }), // priorità utente più alta ma dipende da Lib
      P('Lib.esp', 2),
    ])
    expect(r.ok && r.order).toEqual(['Lib.esp', 'Quest.esp'])
  })

  it('un master vanilla o Creation Club esterno soddisfa senza creare vincoli', () => {
    const r = lootSort(
      [P('Mod.esp', 1, { masters: ['Skyrim.esm', 'ccBGSSSE025-AdvDSGS.esm'] })],
      { externalMasters: ['Skyrim.esm', 'ccBGSSSSE025-AdvDSGS.esm', 'ccBGSSSE025-AdvDSGS.esm'] },
    )
    expect(r.ok && r.order).toEqual(['Mod.esp'])
  })

  it('missing-master: blocco con report COMPLETO, non first-fail', () => {
    const r = lootSort([
      P('A.esp', 1, { masters: ['Assente.esm'] }),
      P('B.esp', 2, { masters: ['AltroAssente.esp', 'A.esp'] }),
    ])
    expect(r).toMatchObject({
      ok: false,
      error: 'missing-master',
      missing: [
        { plugin: 'A.esp', masters: ['Assente.esm'] },
        { plugin: 'B.esp', masters: ['AltroAssente.esp'] },
      ],
    })
  })

  it('header illeggibile: fallbackAfter è vincolo HARD e un suo ciclo blocca', () => {
    const ok = lootSort([
      P('Quest.esp', 1, { masters: null, fallbackAfter: ['Lib.esp'] }),
      P('Lib.esp', 2, { masters: null, fallbackAfter: [] }),
    ])
    expect(ok.ok && ok.order).toEqual(['Lib.esp', 'Quest.esp'])
    const cyc = lootSort([
      P('A.esp', 1, { masters: null, fallbackAfter: ['B.esp'] }),
      P('B.esp', 2, { masters: null, fallbackAfter: ['A.esp'] }),
    ])
    expect(cyc.ok).toBe(false)
    if (!cyc.ok && cyc.error === 'cycle') expect(new Set(cyc.cycle)).toEqual(new Set(['A.esp', 'B.esp']))
  })

  it('le regole "after" ordinano; su ciclo vengono SCARTATE con warning (mai blocco)', () => {
    const plugins = [P('Patch.esp', 1), P('Base.esp', 2)]
    const ok = lootSort(plugins, { rules: [{ plugin: 'Patch.esp', after: ['Base.esp'] }] })
    expect(ok.ok && ok.order).toEqual(['Base.esp', 'Patch.esp'])
    const cyc = lootSort(plugins, {
      rules: [
        { plugin: 'Patch.esp', after: ['Base.esp'] },
        { plugin: 'Base.esp', after: ['Patch.esp'] },
      ],
    })
    expect(cyc.ok).toBe(true)
    if (cyc.ok) {
      expect(cyc.order).toEqual(['Patch.esp', 'Base.esp']) // fallback: sola priorità utente
      expect(cyc.warnings.some((w) => w.includes('regole'))).toBe(true)
    }
  })

  it('vincolo cross-partition impossibile (master che dipende da un regular): warning e via', () => {
    const r = lootSort([
      P('Core.esm', 1, { masters: ['Loose.esp'] }),
      P('Loose.esp', 2),
    ])
    expect(r.ok && r.order).toEqual(['Core.esm', 'Loose.esp'])
    if (r.ok) expect(r.warnings.some((w) => w.includes('non applicabile'))).toBe(true)
  })

  it('groupRank (LOOT reale) vince sulla priorità utente come tie-break; assente = pari merito (in coda)', () => {
    const r = lootSort([
      P('HighPriorityButLateGroup.esp', 1, { groupRank: 5 }),
      P('LowPriorityButEarlyGroup.esp', 9, { groupRank: 1 }),
      P('NoGroupData.esp', 3), // groupRank assente -> Infinity, dopo qualunque rank noto
    ])
    expect(r.ok && r.order).toEqual(['LowPriorityButEarlyGroup.esp', 'HighPriorityButLateGroup.esp', 'NoGroupData.esp'])
  })

  it('ciclo tra master reali: blocco con la catena concreta', () => {
    const r = lootSort([
      P('A.esm', 1, { masters: ['B.esm'] }),
      P('B.esm', 2, { masters: ['A.esm'] }),
      P('Libero.esp', 3),
    ])
    expect(r.ok).toBe(false)
    if (!r.ok && r.error === 'cycle') expect(new Set(r.cycle)).toEqual(new Set(['A.esm', 'B.esm']))
  })
})
