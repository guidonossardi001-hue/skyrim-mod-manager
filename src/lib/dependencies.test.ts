import { describe, it, expect } from 'vitest'
import { resolveInstallPlan } from './dependencies'
import type { CatalogMod } from '@/types'

let id = 0
function mod(name: string, opts: Partial<CatalogMod> = {}): CatalogMod {
  id++
  return {
    id,
    nexus_id: id * 100,
    name,
    category: 'other',
    subcategory: null,
    priority_order: opts.priority_order ?? 100,
    required: 0,
    description: null,
    author: null,
    tags: '[]',
    size_mb: 10,
    has_it_translation: 0,
    notes: null,
    conflicts_with: '[]',
    requires: opts.requires ?? '[]',
    ...opts,
  }
}

describe('resolveInstallPlan', () => {
  it('pulls in a missing dependency and orders it before the target', () => {
    const skse = mod('SKSE64', { priority_order: 1 })
    const skyui = mod('SkyUI', { priority_order: 2, requires: JSON.stringify(['SKSE64']) })
    const plan = resolveInstallPlan(skyui, [skse, skyui], new Set())
    expect(plan.map((p) => p.mod.name)).toEqual(['SKSE64', 'SkyUI'])
    expect(plan.find((p) => p.mod.name === 'SKSE64')!.reason).toBe('dependency')
    expect(plan.find((p) => p.mod.name === 'SkyUI')!.reason).toBe('target')
  })

  it('skips dependencies already installed', () => {
    const skse = mod('SKSE64', { priority_order: 1 })
    const skyui = mod('SkyUI', { priority_order: 2, requires: JSON.stringify(['SKSE64']) })
    const plan = resolveInstallPlan(skyui, [skse, skyui], new Set([skse.nexus_id]))
    expect(plan.map((p) => p.mod.name)).toEqual(['SkyUI'])
  })

  it('resolves transitive dependencies', () => {
    const addr = mod('Address Library', { priority_order: 1 })
    const skse = mod('SKSE64', { priority_order: 2, requires: JSON.stringify(['Address Library']) })
    const racemenu = mod('RaceMenu', { priority_order: 5, requires: JSON.stringify(['SKSE64']) })
    const plan = resolveInstallPlan(racemenu, [addr, skse, racemenu], new Set())
    expect(plan.map((p) => p.mod.name)).toEqual(['Address Library', 'SKSE64', 'RaceMenu'])
  })

  it('is cycle-safe', () => {
    const a = mod('Alpha', { priority_order: 1, requires: JSON.stringify(['Beta']) })
    const b = mod('Beta', { priority_order: 2, requires: JSON.stringify(['Alpha']) })
    const plan = resolveInstallPlan(a, [a, b], new Set())
    expect(plan.map((p) => p.mod.name).sort()).toEqual(['Alpha', 'Beta'])
  })

  it('returns just the target when it has no dependencies', () => {
    const m = mod('Standalone')
    expect(resolveInstallPlan(m, [m], new Set()).map((p) => p.mod.name)).toEqual(['Standalone'])
  })
})
