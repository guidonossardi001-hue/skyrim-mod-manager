import { describe, it, expect } from 'vitest'
import { orderPluginsLoot } from './lootOrder'
import { buildPluginsTxt, type PluginEntry } from './plan'
import type { PluginHeader } from '../plugins/espParser'

const entry = (name: string, mod: string, priority: number): PluginEntry => ({
  name,
  type: name.toLowerCase().endsWith('.esm') ? 'ESM' : name.toLowerCase().endsWith('.esl') ? 'ESL' : 'ESP',
  mod,
  priority,
  src: `X:/mods/${mod}/${name}`,
})
const header = (masters: string[], esm = false): PluginHeader => ({
  isEsm: esm,
  isLight: false,
  masters,
  version: 1.7,
})

describe('orderPluginsLoot', () => {
  it('i master REALI dall’header vincono sulla stima del catalogo', () => {
    // Catalogo dice "Quest richiede Lib" MA gli header dicono l'inverso: vince l'header.
    const plugins = [entry('Lib.esp', 'LibMod', 2), entry('Quest.esp', 'QuestMod', 1)]
    const headers: Record<string, PluginHeader> = {
      'X:/mods/LibMod/Lib.esp': header(['Quest.esp']),
      'X:/mods/QuestMod/Quest.esp': header([]),
    }
    const r = orderPluginsLoot(
      plugins,
      new Map([
        ['QuestMod', 100],
        ['LibMod', 200],
      ]),
      new Map([[100, [200]]]), // stima catalogo (ignorata: header leggibili)
      { readHeader: (p) => headers[p] ?? null },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const seq = new Map(r.plugins.map((p) => [p.name, p.priority]))
      expect(seq.get('Quest.esp')!).toBeLessThan(seq.get('Lib.esp')!)
    }
  })

  it('header illeggibile: fallback sul grafo requires del catalogo (semantica precedente)', () => {
    const plugins = [entry('Quest.esp', 'QuestMod', 1), entry('Lib.esp', 'LibMod', 2)]
    const r = orderPluginsLoot(
      plugins,
      new Map([
        ['QuestMod', 100],
        ['LibMod', 200],
      ]),
      new Map([[100, [200]]]), // Quest richiede Lib
      { readHeader: () => null },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const seq = new Map(r.plugins.map((p) => [p.name, p.priority]))
      expect(seq.get('Lib.esp')!).toBeLessThan(seq.get('Quest.esp')!)
    }
  })

  it('missing-master blocca; vanilla e Creation Club esterni NON contano come mancanti', () => {
    const plugins = [entry('Mod.esp', 'M', 1)]
    const h: PluginHeader = header(['Skyrim.esm', 'ccQDRSSE001-SurvivalMode.esl', 'Assente.esm'])
    const r = orderPluginsLoot(plugins, new Map(), new Map(), {
      readHeader: () => h,
      externalMasters: ['ccQDRSSE001-SurvivalMode.esl'],
    })
    expect(r).toMatchObject({
      ok: false,
      kind: 'missing-master',
      missing: [{ plugin: 'Mod.esp', masters: ['Assente.esm'] }],
    })
  })

  it('la sequenza calcolata guida plugins.txt (masters topologici prima, poi regular)', () => {
    const plugins = [
      entry('Weapons.esp', 'W', 1),
      entry('Core.esm', 'C', 9),
      entry('AddonCore.esm', 'A', 5), // dipende da Core.esm nonostante priorità utente migliore
    ]
    const headers: Record<string, PluginHeader> = {
      'X:/mods/W/Weapons.esp': header(['Core.esm']),
      'X:/mods/C/Core.esm': header([], true),
      'X:/mods/A/AddonCore.esm': header(['Core.esm'], true),
    }
    const r = orderPluginsLoot(plugins, new Map(), new Map(), { readHeader: (p) => headers[p] ?? null })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const lines = buildPluginsTxt(r.plugins).trim().split('\n')
      const at = (n: string) => lines.findIndex((l) => l === `*${n}`)
      expect(at('Core.esm')).toBeLessThan(at('AddonCore.esm'))
      expect(at('AddonCore.esm')).toBeLessThan(at('Weapons.esp'))
    }
  })

  it('groupRankByPattern (masterlist LOOT reale) guida l’ordine, anche coi pattern regex', () => {
    const plugins = [entry('LatePatch.esp', 'L', 1), entry('EarlyFix.esp', 'E', 9)]
    const headers: Record<string, PluginHeader> = {
      'X:/mods/L/LatePatch.esp': header([]),
      'X:/mods/E/EarlyFix.esp': header([]),
    }
    const r = orderPluginsLoot(plugins, new Map(), new Map(), {
      readHeader: (p) => headers[p] ?? null,
      groupRankByPattern: [
        { pluginPattern: 'LatePatch\\.esp', rank: 9 }, // regex (escape letterale)
        { pluginPattern: 'EarlyFix.esp', rank: 1 }, // match letterale case-insensitive
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const seq = new Map(r.plugins.map((p) => [p.name, p.priority]))
      expect(seq.get('EarlyFix.esp')!).toBeLessThan(seq.get('LatePatch.esp')!)
    }
  })

  it('ciclo tra header reali → dependency-cycle (stessa shape gestita dal deployer)', () => {
    const plugins = [entry('A.esp', 'MA', 1), entry('B.esp', 'MB', 2)]
    const headers: Record<string, PluginHeader> = {
      'X:/mods/MA/A.esp': header(['B.esp']),
      'X:/mods/MB/B.esp': header(['A.esp']),
    }
    const r = orderPluginsLoot(plugins, new Map(), new Map(), { readHeader: (p) => headers[p] ?? null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('dependency-cycle')
  })
})
