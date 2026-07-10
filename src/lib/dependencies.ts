import type { CatalogMod } from '@/types'
import { parseRequires } from './modUtils'

// Dependency resolution, the way large modlists (Nolvus/Wabbajack) build an
// install order: given a target mod, walk its `requires` transitively, pull in
// any missing prerequisites from the catalog, drop what's already installed,
// and order everything by `priority_order` (frameworks first). Pure & testable.

export interface InstallPlanItem {
  mod: CatalogMod
  reason: 'target' | 'dependency'
}

/** Find the catalog entry that satisfies a `requires` token (fuzzy name match). */
function matchRequirement(req: string, catalog: CatalogMod[]): CatalogMod | undefined {
  const r = req.trim().toLowerCase()
  if (!r) return undefined
  // Prefer an exact-ish name hit, then fall back to substring containment.
  return (
    catalog.find((m) => m.name.toLowerCase() === r) ?? catalog.find((m) => m.name.toLowerCase().includes(r))
  )
}

export function resolveInstallPlan(
  target: CatalogMod,
  catalog: CatalogMod[],
  installedNexusIds: Set<number>,
): InstallPlanItem[] {
  const planned = new Map<number, InstallPlanItem>()
  const seen = new Set<number>() // cycle guard

  const keyOf = (m: CatalogMod) => m.nexus_id || m.id

  const visit = (mod: CatalogMod, reason: 'target' | 'dependency') => {
    const key = keyOf(mod)
    if (seen.has(key)) return
    seen.add(key)
    // Skip mods already installed (matched by nexus id), except keep the target
    // visible to the caller via reason handling — but an installed target means
    // nothing to do, so we still skip it here.
    if (mod.nexus_id && installedNexusIds.has(mod.nexus_id)) return

    // Resolve dependencies before recording the mod itself.
    for (const req of parseRequires(mod.requires)) {
      const dep = matchRequirement(req, catalog)
      if (dep && keyOf(dep) !== key) visit(dep, 'dependency')
    }

    if (!planned.has(key)) planned.set(key, { mod, reason })
  }

  visit(target, 'target')

  return [...planned.values()].sort((a, b) => a.mod.priority_order - b.mod.priority_order)
}
