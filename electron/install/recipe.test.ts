import { describe, it, expect } from 'vitest'
import { planRecipe, resolveRel, type InstallInstructions } from './recipe'

// Pure planner — no DB, no fs. Inputs are mock archive listings (the flat set of
// paths 7-Zip would have extracted), exactly as planRecipe consumes them.

/** dest set of a successful plan (lowercased for order-independent assertions). */
const dests = (r: ReturnType<typeof planRecipe>) => (r.mappings ?? []).map((m) => m.destRel)
const srcOf = (r: ReturnType<typeof planRecipe>, destRel: string) =>
  (r.mappings ?? []).find((m) => m.destRel === destRel)?.src

// A realistic FOMOD-style archive: a Core folder, two mutually-exclusive texture
// options, and the FOMOD metadata + a readme that must never ship.
const FOMOD_ARCHIVE = [
  '00 Core/meshes/armor.nif',
  '00 Core/textures/armor.dds',
  '01 Option 2K/textures/armor.dds',
  '02 Option 4K/textures/armor.dds',
  'fomod/ModuleConfig.xml',
  'fomod/info.xml',
  'readme.txt',
]

describe('planRecipe', () => {
  it('happy path (FOMOD): includes 00 Core + 02 Option 4K with stripPrefix → files land at mod root', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        { op: 'include', match: '02 Option 4K', stripPrefix: true },
      ],
      expect: { minFiles: 2, mustContain: ['meshes/armor.nif', 'textures/armor.dds'] },
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(true)
    expect(dests(r).sort()).toEqual(['meshes/armor.nif', 'textures/armor.dds'])
    // 4K option overwrites Core at the shared destination (later include wins).
    expect(srcOf(r, 'textures/armor.dds')).toBe('02 Option 4K/textures/armor.dds')
    expect(srcOf(r, 'meshes/armor.nif')).toBe('00 Core/meshes/armor.nif')
  })

  it('implicit drop: unmentioned 2K option, fomod metadata and readme never appear', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        { op: 'include', match: '02 Option 4K', stripPrefix: true },
      ],
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(true)
    const all = dests(r).join('|')
    expect(all).not.toMatch(/2K/i)
    expect(all).not.toMatch(/fomod/i)
    expect(all).not.toMatch(/readme/i)
    // Only the two Core/4K files survive.
    expect(r.mappings).toHaveLength(2)
  })

  it('dest remap: include under a destination prefix (no stripPrefix strips, dest re-roots)', () => {
    const files = ['00 Core/SKSE/plugins/foo.dll', '00 Core/readme.txt']
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 Core/SKSE', stripPrefix: true, dest: 'SKSE' }],
    }
    const r = planRecipe(files, recipe)
    expect(r.success).toBe(true)
    expect(dests(r)).toEqual(['SKSE/plugins/foo.dll'])
  })

  it('exclude: a subpath of an included tree is removed (later rule overrides earlier)', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        { op: 'exclude', match: '00 Core/textures' },
      ],
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(true)
    expect(dests(r)).toEqual(['meshes/armor.nif']) // textures/armor.dds excluded
  })

  it('rename: a single file is redirected to a corrected dest path', () => {
    const files = ['00 Core/SKSE/plugins/foo.dll']
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        { op: 'rename', match: '00 Core/SKSE/plugins/foo.dll', to: 'SKSE/Plugins/foo.dll' },
      ],
    }
    const r = planRecipe(files, recipe)
    expect(r.success).toBe(true)
    expect(dests(r)).toEqual(['SKSE/Plugins/foo.dll'])
    expect(srcOf(r, 'SKSE/Plugins/foo.dll')).toBe('00 Core/SKSE/plugins/foo.dll')
  })

  it('glob match: **/*.esp selects plugins anywhere in the tree', () => {
    const files = ['00 Core/mod.esp', '00 Core/sub/patch.esp', '00 Core/textures/x.dds']
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '**/*.esp', matchType: 'glob' }],
    }
    const r = planRecipe(files, recipe)
    expect(r.success).toBe(true)
    expect(dests(r).sort()).toEqual(['00 Core/mod.esp', '00 Core/sub/patch.esp'])
  })

  it('case-insensitive matching (Windows FS): "00 core" matches "00 Core/…"', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 core', stripPrefix: true }],
    }
    const r = planRecipe(['00 Core/meshes/armor.nif'], recipe)
    expect(r.success).toBe(true)
    expect(dests(r)).toEqual(['meshes/armor.nif'])
  })

  it('backslash archive paths are normalized; src is preserved, destRel is forward-slashed', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 Core', stripPrefix: true }],
    }
    const r = planRecipe(['00 Core\\meshes\\armor.nif'], recipe)
    expect(r.success).toBe(true)
    expect(r.mappings![0]).toEqual({ src: '00 Core\\meshes\\armor.nif', destRel: 'meshes/armor.nif' })
  })

  it('archiveRoot: files under a nested Data/ root are made relative to it, others dropped', () => {
    const files = ['Data/meshes/a.nif', 'Data/textures/b.dds', 'docs/manual.pdf']
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      archiveRoot: 'Data',
      rules: [{ op: 'include', match: 'meshes', stripPrefix: false }],
    }
    const r = planRecipe(files, recipe)
    expect(r.success).toBe(true)
    expect(dests(r)).toEqual(['meshes/a.nif']) // textures not included, docs outside archiveRoot
  })

  it("strategy 'root' flattens the whole archive relative to archiveRoot", () => {
    const files = ['Data/a.esp', 'Data/textures/b.dds']
    const r = planRecipe(files, { schema_version: 1, strategy: 'root', archiveRoot: 'Data' })
    expect(r.success).toBe(true)
    expect(dests(r).sort()).toEqual(['a.esp', 'textures/b.dds'])
  })

  // ── Security: recipe-slip ──────────────────────────────────────────────────

  it('attack vector: a rename escaping the mod root is blocked (recipe-slip)', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        {
          op: 'rename',
          match: '00 Core/textures/armor.dds',
          to: '../../../Windows/System32/evil.dll',
        },
      ],
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('recipe-slip')
    expect(r.errors?.[0]).toMatch(/System32/i)
  })

  it('attack vector: a dest prefix that walks out of the root is blocked', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 Core', stripPrefix: true, dest: '../../evil' }],
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('recipe-slip')
  })

  it('resolveRel blocks absolute / drive-letter / UNC / escaping paths, allows inner ..', () => {
    expect(resolveRel('C:/Windows/x').slip).toBe(true)
    expect(resolveRel('/etc/passwd').slip).toBe(true)
    expect(resolveRel('\\\\server\\share\\x').slip).toBe(true)
    expect(resolveRel('../escape').slip).toBe(true)
    expect(resolveRel('a/../../b').slip).toBe(true)
    expect(resolveRel('a/./b/../c')).toEqual({ path: 'a/c', slip: false }) // harmless, collapses
  })

  // ── Post-conditions: expect ─────────────────────────────────────────────────

  it('expect failure: a recipe that selects zero files fails with errorKind "empty"', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: 'DoesNotExist', stripPrefix: true }],
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('empty')
  })

  it('expect failure: a declared vital file (mustContain) missing from the plan fails', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 Core', stripPrefix: true }],
      expect: { mustContain: ['SKSE/Plugins/vital.dll'] }, // not in the archive
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('expect')
    expect(r.errors?.[0]).toMatch(/vital\.dll/i)
  })

  it('expect failure: minFiles not met fails even when some files matched', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [{ op: 'include', match: '00 Core/meshes', stripPrefix: true }],
      expect: { minFiles: 5 },
    }
    const r = planRecipe(FOMOD_ARCHIVE, recipe)
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('expect')
    expect(r.errors?.[0]).toMatch(/almeno 5/i)
  })

  it('expect success: mustContain + minFiles both satisfied', () => {
    const recipe: InstallInstructions = {
      schema_version: 1,
      strategy: 'recipe',
      rules: [
        { op: 'include', match: '00 Core', stripPrefix: true },
        { op: 'include', match: '02 Option 4K', stripPrefix: true },
      ],
      expect: { minFiles: 2, mustContain: ['textures/armor.dds'] },
    }
    expect(planRecipe(FOMOD_ARCHIVE, recipe).success).toBe(true)
  })

  // ── Malformed input ─────────────────────────────────────────────────────────

  it('invalid: unknown strategy fails as "invalid", never throws', () => {
    const r = planRecipe([], { schema_version: 1, strategy: 'bogus' as never })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('invalid')
  })

  it('invalid: recipe strategy with no rules fails as "invalid"', () => {
    const r = planRecipe(FOMOD_ARCHIVE, { schema_version: 1, strategy: 'recipe' })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('invalid')
  })
})
