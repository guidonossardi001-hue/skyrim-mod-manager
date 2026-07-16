import { describe, it, expect } from 'vitest'
import {
  computeDeployPlan,
  buildPluginsTxt,
  orderPluginsByDependencies,
  parseDeployManifest,
  looksLikeDataRoot,
  stripWrapperDirs,
  BASE_MASTERS,
  type DeployMod,
  type PluginEntry,
} from './plan'

const mod = (
  name: string,
  priority: number,
  files: string[],
  extra: Partial<DeployMod> = {},
): DeployMod => ({
  name,
  priority,
  rootDir: `/mods/${name}`,
  files,
  ...extra,
})

const junctionDirs = (p: ReturnType<typeof computeDeployPlan>) => p.junctions.map((j) => j.dir).sort()
const hardlinkRels = (p: ReturnType<typeof computeDeployPlan>) => p.hardlinks.map((h) => h.rel).sort()

describe('computeDeployPlan — override', () => {
  it('higher priority overrides the same destination path (last writer wins)', () => {
    const plan = computeDeployPlan([
      mod('Low', 1, ['data.txt']),
      mod('High', 2, ['data.txt']),
    ])
    const link = plan.hardlinks.find((h) => h.rel === 'data.txt')
    expect(link?.mod).toBe('High')
    expect(link?.src).toBe('/mods/High/data.txt')
  })

  it('is deterministic regardless of input order (priority decides, name tie-breaks)', () => {
    const a = computeDeployPlan([mod('High', 2, ['x.txt']), mod('Low', 1, ['x.txt'])])
    const b = computeDeployPlan([mod('Low', 1, ['x.txt']), mod('High', 2, ['x.txt'])])
    expect(a.hardlinks).toEqual(b.hardlinks)
    expect(a.hardlinks[0].mod).toBe('High')
  })
})

describe('computeDeployPlan — junction vs hardlink', () => {
  it('junctions a single-provider top-level directory whole', () => {
    const plan = computeDeployPlan([mod('A', 1, ['textures/a.dds', 'textures/sub/b.dds', 'root.esp'])])
    expect(junctionDirs(plan)).toEqual(['textures']) // whole textures owned by A
    // files under the junction are NOT also hardlinked; the root plugin is
    expect(hardlinkRels(plan)).toEqual(['root.esp'])
  })

  it('splits a shared top dir into per-mod subdir junctions, hardlinks true conflicts', () => {
    const plan = computeDeployPlan([
      mod('A', 1, ['textures/onlyA/x.dds', 'textures/shared/c.dds']),
      mod('B', 2, ['textures/onlyB/y.dds', 'textures/shared/c.dds']), // overrides shared/c.dds
    ])
    // 'textures' is mixed → descend; each single-provider subdir junctions.
    expect(junctionDirs(plan)).toEqual(['textures/onlyA', 'textures/onlyB', 'textures/shared'])
    const shared = plan.junctions.find((j) => j.dir === 'textures/shared')
    expect(shared?.mod).toBe('B') // higher priority owns the shared subtree after override
    expect(plan.hardlinks).toHaveLength(0)
  })

  it('hardlinks individual files when two mods interleave files in the same directory', () => {
    const plan = computeDeployPlan([
      mod('A', 1, ['meshes/a.nif']),
      mod('B', 2, ['meshes/b.nif']), // same dir, different files → dir is multi-provider
    ])
    expect(plan.junctions).toHaveLength(0)
    expect(hardlinkRels(plan)).toEqual(['meshes/a.nif', 'meshes/b.nif'])
  })
})

describe('computeDeployPlan — automatic conflict resolution', () => {
  it('two textures on the same file: higher resolutionWeight (4K) wins over 2K, no throw', () => {
    // Note: the 4K mod has the LOWER priority (2 < 5) yet still wins — Rule 2
    // (weight) outranks Rule 3 (priority) for same-class collisions.
    const build = () =>
      computeDeployPlan([
        mod('Tex2K', 5, ['textures/armor/steel.dds', 'textures/armor/only2k.dds'], {
          category: 'texture',
          resolutionWeight: 2000,
        }),
        mod('Tex4K', 2, ['textures/armor/steel.dds', 'textures/armor/only4k.dds'], {
          category: 'texture',
          resolutionWeight: 4000,
        }),
      ])
    expect(build).not.toThrow()
    const plan = build()
    const steel = plan.hardlinks.find((h) => h.rel === 'textures/armor/steel.dds')
    expect(steel?.mod).toBe('Tex4K')
    expect(steel?.src).toBe('/mods/Tex4K/textures/armor/steel.dds')
    expect(plan.resolvedConflicts).toContainEqual({
      file: 'textures/armor/steel.dds',
      winner: 'Tex4K',
      loser: 'Tex2K',
    })
  })

  it('a patch always beats a texture (Rule 1), even with lower weight and priority', () => {
    const plan = computeDeployPlan([
      mod('HDTexture', 9, ['textures/w.dds', 'textures/hd.dds'], {
        category: 'texture',
        resolutionWeight: 8000,
      }),
      mod('CompatPatch', 1, ['textures/w.dds', 'textures/patch.dds'], { category: 'patch' }),
    ])
    const w = plan.hardlinks.find((h) => h.rel === 'textures/w.dds')
    expect(w?.mod).toBe('CompatPatch') // patch rank beats texture rank outright
    expect(plan.resolvedConflicts).toContainEqual({
      file: 'textures/w.dds',
      winner: 'CompatPatch',
      loser: 'HDTexture',
    })
  })

  it('falls back to priority_order when category and weight are equal (Rule 3)', () => {
    const plan = computeDeployPlan([
      mod('A', 1, ['textures/x.dds', 'textures/a.dds'], { category: 'texture', resolutionWeight: 2000 }),
      mod('B', 2, ['textures/x.dds', 'textures/b.dds'], { category: 'texture', resolutionWeight: 2000 }),
    ])
    const x = plan.hardlinks.find((h) => h.rel === 'textures/x.dds')
    expect(x?.mod).toBe('B') // higher priority wins the tie
    expect(plan.resolvedConflicts).toContainEqual({ file: 'textures/x.dds', winner: 'B', loser: 'A' })
  })

  it('records nothing when no two mods write the same file', () => {
    const plan = computeDeployPlan([
      mod('A', 1, ['textures/a.dds']),
      mod('B', 2, ['meshes/b.nif']),
    ])
    expect(plan.resolvedConflicts).toEqual([])
  })

  it('the resolved-conflict log is deterministic regardless of input order', () => {
    const a = computeDeployPlan([
      mod('Tex2K', 5, ['t/s.dds', 't/o2.dds'], { category: 'texture', resolutionWeight: 2000 }),
      mod('Tex4K', 2, ['t/s.dds', 't/o4.dds'], { category: 'texture', resolutionWeight: 4000 }),
    ])
    const b = computeDeployPlan([
      mod('Tex4K', 2, ['t/s.dds', 't/o4.dds'], { category: 'texture', resolutionWeight: 4000 }),
      mod('Tex2K', 5, ['t/s.dds', 't/o2.dds'], { category: 'texture', resolutionWeight: 2000 }),
    ])
    expect(a.resolvedConflicts).toEqual(b.resolvedConflicts)
  })
})

describe('buildPluginsTxt', () => {
  it('orders masters first (ESM → ESL → ESP), then by mod priority, with * on mod plugins', () => {
    const plan = computeDeployPlan([
      mod('A', 1, ['Alpha.esp', 'Light.esl']),
      mod('B', 2, ['Big.esm']),
    ])
    const txt = buildPluginsTxt(plan.plugins)
    const lines = txt.trim().split('\n')
    expect(lines[0]).toMatch(/^#/) // header comment
    // base masters block, unprefixed
    for (const m of BASE_MASTERS) expect(lines).toContain(m)
    const modLines = lines.filter((l) => l.startsWith('*'))
    expect(modLines).toEqual(['*Big.esm', '*Light.esl', '*Alpha.esp']) // ESM, ESL, ESP
  })

  it('does not duplicate a base master a mod also ships', () => {
    const plan = computeDeployPlan([mod('A', 1, ['Update.esm', 'Custom.esp'])])
    const txt = buildPluginsTxt(plan.plugins)
    const updates = txt.split('\n').filter((l) => /update\.esm/i.test(l))
    expect(updates).toHaveLength(1) // only the base-master line, not a duplicate '*Update.esm'
    expect(updates[0]).toBe('Update.esm')
  })
})

// ── Wrapper con nome ARBITRARIO (regressione reale 2026-07-17) ───────────────
// Il deploy di 1939 mod si bloccava con "BSHeartland.esm master mancante" benché il file
// fosse su disco: sta in `10917-Beyond Skyrim Bruma/Beyond Skyrim Bruma/BSHeartland.esm`,
// cioè dentro un wrapper col nome della mod. Lo strip riconosceva solo il nome letterale
// 'data', quindi i plugin non erano alla radice Data e sparivano dal load order.
// Erano 489 mod su 1940.

describe('looksLikeDataRoot', () => {
  it('riconosce una Data valida da plugin/BSA alla radice', () => {
    expect(looksLikeDataRoot(['BSHeartland.esm'])).toBe(true)
    expect(looksLikeDataRoot(['Foo.bsa'])).toBe(true)
    expect(looksLikeDataRoot(['x.esl', 'readme.txt'])).toBe(true)
  })
  it('riconosce una Data valida da directory canoniche di primo livello', () => {
    expect(looksLikeDataRoot(['textures/x.dds'])).toBe(true)
    expect(looksLikeDataRoot(['SKSE/Plugins/a.dll'])).toBe(true)
    expect(looksLikeDataRoot(['MESHES/a.nif'])).toBe(true) // case-insensitive
  })
  it('NON riconosce un albero incapsulato in un wrapper arbitrario', () => {
    expect(looksLikeDataRoot(['Beyond Skyrim Bruma/BSHeartland.esm'])).toBe(false)
    expect(looksLikeDataRoot(['Data/x.esp'])).toBe(false)
    expect(looksLikeDataRoot(['readme.txt'])).toBe(false)
  })
})

describe('stripWrapperDirs', () => {
  it('toglie un wrapper col nome della mod (il caso Bruma reale)', () => {
    const r = stripWrapperDirs(['Beyond Skyrim Bruma/BSHeartland.esm', 'Beyond Skyrim Bruma/BSHeartland.bsa'])
    expect(r.files).toEqual(['BSHeartland.esm', 'BSHeartland.bsa'])
    expect(r.segments).toEqual(['Beyond Skyrim Bruma'])
  })
  it('toglie wrapper ANNIDATI (Mod/Data/...)', () => {
    const r = stripWrapperDirs(['My Mod/Data/Thing.esp', 'My Mod/Data/textures/t.dds'])
    expect(r.files).toEqual(['Thing.esp', 'textures/t.dds'])
    expect(r.segments).toEqual(['My Mod', 'Data'])
  })
  it('una Data GIÀ valida non viene toccata', () => {
    expect(stripWrapperDirs(['textures/x.dds']).segments).toEqual([])
    expect(stripWrapperDirs(['SkyUI.esp', 'interface/x.swf']).segments).toEqual([])
  })
  it('mod di sole texture: `textures/` NON è un wrapper da togliere', () => {
    const r = stripWrapperDirs(['textures/armor/a.dds', 'textures/armor/b.dds'])
    expect(r.segments).toEqual([])
    expect(r.files).toEqual(['textures/armor/a.dds', 'textures/armor/b.dds'])
  })
  it('albero non uniforme → nessuno strip (comportamento storico)', () => {
    expect(stripWrapperDirs(['A/x.esp', 'B/y.esp']).segments).toEqual([])
  })
  it('FAIL-SAFE: se dopo lo strip l’albero non è Data-like, non si strippa', () => {
    // "Docs/manuale/pagina.dat" → togliendo Docs resterebbe "manuale/..." che non è Data.
    const r = stripWrapperDirs(['Docs/manuale/pagina.dat', 'Docs/manuale/altro.dat'])
    expect(r.segments).toEqual([])
  })
  it('readme e fomod alla radice non impediscono di riconoscere il wrapper', () => {
    const r = stripWrapperDirs(['readme.txt', 'Cool Mod/Cool.esp', 'Cool Mod/meshes/a.nif'])
    expect(r.segments).toEqual(['Cool Mod'])
    expect(r.files).toContain('Cool.esp')
  })
  it('non va in loop infinito su alberi profondi (cap di profondità)', () => {
    const deep = ['a/b/c/d/e/f/g/plugin.esp']
    expect(stripWrapperDirs(deep).segments.length).toBeLessThanOrEqual(3)
  })
})

describe('computeDeployPlan — wrapper arbitrario', () => {
  it('il plugin dentro un wrapper col nome della mod entra nel load order (fix Bruma)', () => {
    const plan = computeDeployPlan([
      mod('Beyond Skyrim Bruma', 1, [
        'Beyond Skyrim Bruma/BSHeartland.esm',
        'Beyond Skyrim Bruma/BSHeartland.bsa',
        'Beyond Skyrim Bruma/textures/bruma/t.dds',
      ]),
    ])
    expect(plan.plugins.map((p) => p.name)).toEqual(['BSHeartland.esm'])
    // La sorgente punta DENTRO il wrapper, il path di destinazione è Data-relative.
    const src = [...plan.hardlinks.map((h) => h.src), ...plan.junctions.map((j) => j.src)]
    expect(src.every((s) => s.includes('/Beyond Skyrim Bruma/Beyond Skyrim Bruma/'))).toBe(true)
    expect(plan.hardlinks.every((h) => !h.rel.includes('Beyond Skyrim Bruma/'))).toBe(true)
  })

  it('una mod di sole texture NON viene strippata (nessun falso positivo)', () => {
    const plan = computeDeployPlan([mod('Texture Pack', 1, ['textures/a.dds', 'textures/b.dds'])])
    expect(plan.junctions.map((j) => j.dir)).toEqual(['textures'])
  })
})

describe('computeDeployPlan — normalizzazione wrapper Data/ e casing', () => {
  it('una mod incapsulata in Data/ deploya alla root (plugin incluso) con sorgenti dentro Data/', () => {
    const plan = computeDeployPlan([
      mod('MCM Helper', 1, ['Data/MCM/settings.ini', 'Data/MCMHelper.esp', 'Data/SKSE/Plugins/MCMHelper.dll']),
    ])
    // Niente Data/Data: i percorsi sono Data-relative.
    expect(plan.hardlinks.every((h) => !h.rel.toLowerCase().startsWith('data/'))).toBe(true)
    expect(plan.junctions.every((j) => !j.dir.toLowerCase().startsWith('data/'))).toBe(true)
    // Il plugin annidato sotto Data/ ora è alla root ed entra nel load order.
    expect(plan.plugins.map((p) => p.name)).toEqual(['MCMHelper.esp'])
    // Le sorgenti puntano DENTRO la cartella Data della mod.
    const all = [...plan.hardlinks.map((h) => h.src), ...plan.junctions.map((j) => j.src)]
    expect(all.every((s) => s.includes('/mods/MCM Helper/Data/'))).toBe(true)
  })

  it('mod mista (solo ALCUNI file sotto Data/) NON viene riscritta (wrapper solo se uniforme)', () => {
    const plan = computeDeployPlan([mod('Mixed', 1, ['Data/x.dds', 'root.esp'])])
    // Il prefisso Data/ resta (albero non uniforme): la dir diventa una normale junction
    // single-provider e il file di root un hardlink — nessuno strip parziale.
    expect(plan.junctions.map((j) => j.dir)).toEqual(['Data'])
    expect(plan.hardlinks.map((h) => h.rel)).toEqual(['root.esp'])
  })

  it('stessa directory con casing diverso da due mod → un solo owner per file, MAI due junction in collisione', () => {
    const plan = computeDeployPlan([
      mod('A', 1, ['MCM/config/a.json']),
      mod('B', 2, ['mcm/config/b.json']),
    ])
    // Directory condivisa (case-insensitive) → niente junction sulla radice contesa…
    expect(plan.junctions.filter((j) => j.dir.toLowerCase() === 'mcm')).toHaveLength(0)
    // …e i file distinti coesistono come hardlink singoli.
    expect(plan.hardlinks).toHaveLength(2)
  })
})

describe('orderPluginsByDependencies — load order sul grafo requires', () => {
  const pe = (name: string, modName: string, priority: number): PluginEntry => ({
    name,
    type: 'ESP',
    mod: modName,
    priority,
  })

  it('riordina: la dipendenza precede il dipendente anche con priorità utente invertite', () => {
    const plugins = [pe('Quest.esp', 'Quest', 1), pe('Lib.esp', 'Lib', 9)]
    const ids = new Map([
      ['Quest', 100],
      ['Lib', 200],
    ])
    const r = orderPluginsByDependencies(plugins, ids, new Map([[100, [200]]]))
    if (!r.ok) throw new Error('inatteso: ciclo')
    const txt = buildPluginsTxt(r.plugins)
    const lines = txt.trim().split('\n')
    expect(lines.indexOf('*Lib.esp')).toBeLessThan(lines.indexOf('*Quest.esp'))
  })

  it('senza vincoli il tie-break resta (priorità utente, nome) — ordine stabile', () => {
    const plugins = [pe('B.esp', 'B', 2), pe('A.esp', 'A', 1)]
    const r = orderPluginsByDependencies(plugins, new Map(), new Map())
    if (!r.ok) throw new Error('inatteso')
    expect(r.plugins.map((p) => p.name)).toEqual(['B.esp', 'A.esp']) // input preservato
    const txt = buildPluginsTxt(r.plugins)
    expect(txt.indexOf('*A.esp')).toBeLessThan(txt.indexOf('*B.esp')) // priorità 1 prima di 2
  })

  it('dipendenze ESTERNE al deploy non vincolano (nessun deadlock su master assente)', () => {
    const plugins = [pe('Solo.esp', 'Solo', 1)]
    const r = orderPluginsByDependencies(plugins, new Map([['Solo', 1]]), new Map([[1, [999]]]))
    expect(r.ok).toBe(true)
  })

  it('fail-safe: un ciclo ritorna ok=false col percorso del ciclo, mai un ordine parziale', () => {
    const plugins = [pe('A.esp', 'A', 1), pe('B.esp', 'B', 2)]
    const ids = new Map([
      ['A', 1],
      ['B', 2],
    ])
    const r = orderPluginsByDependencies(
      plugins,
      ids,
      new Map([
        [1, [2]],
        [2, [1]],
      ]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.cycle.length).toBeGreaterThanOrEqual(2)
      expect(r.cycle).toContain('A')
      expect(r.cycle).toContain('B')
    }
  })

  it('catena transitiva: C→B→A produce A, B, C qualunque sia la priorità utente', () => {
    const plugins = [pe('C.esp', 'C', 0), pe('A.esp', 'A', 5), pe('B.esp', 'B', 3)]
    const ids = new Map([
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ])
    const r = orderPluginsByDependencies(
      plugins,
      ids,
      new Map([
        [3, [2]],
        [2, [1]],
      ]),
    )
    if (!r.ok) throw new Error('inatteso: ciclo')
    const txt = buildPluginsTxt(r.plugins)
    const at = (n: string) => txt.indexOf(`*${n}`)
    expect(at('A.esp')).toBeLessThan(at('B.esp'))
    expect(at('B.esp')).toBeLessThan(at('C.esp'))
  })
})

describe('parseDeployManifest', () => {
  it('round-trip di un manifest valido; forme inattese → null', () => {
    const good = JSON.stringify({
      version: 1,
      target: 'C:/inst/Data',
      junctions: ['textures'],
      files: ['a.esp', 7, 'b.dds'], // il 7 spurio viene filtrato
      pluginsTxt: 'C:/inst/plugins.txt',
    })
    const m = parseDeployManifest(good)
    expect(m?.files).toEqual(['a.esp', 'b.dds'])
    expect(m?.junctions).toEqual(['textures'])
    expect(parseDeployManifest('{"version":2,"target":"x","junctions":[],"files":[]}')).toBeNull()
    expect(parseDeployManifest('non-json')).toBeNull()
    expect(parseDeployManifest('{"version":1}')).toBeNull()
  })
})
