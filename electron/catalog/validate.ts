import type { ModCatalog, CatalogModEntry } from './types'

// Structural + referential validation of an ALREADY-VERIFIED catalog body (the
// signature/hash/version checks happened in verify.ts — this only checks shape
// and cross-references). All-or-nothing: collects every error found instead of
// stopping at the first, so a single ingest attempt reports the full problem
// set and CatalogService.ingest() never touches the DB on a partial pass.

export interface ValidateResult {
  ok: boolean
  errors: string[]
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

function validateEntry(m: CatalogModEntry, at: string, errors: string[]): void {
  if (!isPosInt(m?.nexus_id)) errors.push(`${at}: nexus_id mancante o non intero positivo`)
  if (!isNonEmptyString(m?.name)) errors.push(`${at}: name mancante`)
  if (!isNonEmptyString(m?.category)) errors.push(`${at}: category mancante`)

  if (m.subcategory != null && typeof m.subcategory !== 'string') errors.push(`${at}: subcategory non stringa`)
  if (m.priority_order != null && !Number.isInteger(m.priority_order))
    errors.push(`${at}: priority_order non intero`)
  if (m.required != null && m.required !== 0 && m.required !== 1) errors.push(`${at}: required non 0/1`)
  if (m.description != null && typeof m.description !== 'string')
    errors.push(`${at}: description non stringa`)
  if (m.author != null && typeof m.author !== 'string') errors.push(`${at}: author non stringa`)
  if (m.tags != null && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')))
    errors.push(`${at}: tags non è un array di stringhe`)
  if (m.size_mb != null && (typeof m.size_mb !== 'number' || m.size_mb < 0))
    errors.push(`${at}: size_mb non valido`)
  if (m.has_it_translation != null && m.has_it_translation !== 0 && m.has_it_translation !== 1)
    errors.push(`${at}: has_it_translation non 0/1`)
  if (m.notes != null && typeof m.notes !== 'string') errors.push(`${at}: notes non stringa`)
  // Auto-resolution metadata (drives computeDeployPlan): validated at the trust
  // boundary so a malformed signed catalog can't inject a bogus asset class or weight.
  if (
    m.deployCategory != null &&
    !['patch', 'gameplay', 'texture', 'mesh', 'misc'].includes(m.deployCategory)
  )
    errors.push(`${at}: deployCategory non valido`)
  if (
    m.resolutionWeight != null &&
    (typeof m.resolutionWeight !== 'number' || !Number.isInteger(m.resolutionWeight) || m.resolutionWeight < 0)
  )
    errors.push(`${at}: resolutionWeight non intero non negativo`)
  if (
    m.conflicts_with != null &&
    (!Array.isArray(m.conflicts_with) || m.conflicts_with.some((c) => !isPosInt(c)))
  )
    errors.push(`${at}: conflicts_with non è un array di nexus_id validi`)
  if (m.requires != null && (!Array.isArray(m.requires) || m.requires.some((r) => !isPosInt(r))))
    errors.push(`${at}: requires non è un array di nexus_id validi`)
}

export function validateCatalog(cat: ModCatalog): ValidateResult {
  const errors: string[] = []

  if (!cat || typeof cat !== 'object') return { ok: false, errors: ['catalogo assente o non oggetto'] }
  if (!Array.isArray(cat.mods) || cat.mods.length === 0)
    return { ok: false, errors: ['catalogo vuoto: mods deve essere un array non vuoto'] }
  if (cat.min_app_version != null && !isNonEmptyString(cat.min_app_version))
    errors.push('min_app_version presente ma non è una stringa non vuota')

  const seen = new Set<number>()
  const dupes = new Set<number>()
  cat.mods.forEach((m, i) => {
    validateEntry(m, `mod[${i}]`, errors)
    if (isPosInt(m?.nexus_id)) {
      if (seen.has(m.nexus_id)) dupes.add(m.nexus_id)
      seen.add(m.nexus_id)
    }
  })
  for (const d of dupes) errors.push(`nexus_id duplicato nel catalogo: ${d}`)

  // Referential integrity: requires/conflicts_with must point at a nexus_id
  // present in THIS catalog — a dangling reference breaks resolveInstallPlan
  // (src/lib/dependencies.ts) downstream.
  for (const m of cat.mods) {
    if (!isPosInt(m?.nexus_id)) continue // already reported above
    for (const dep of m.requires ?? []) {
      if (!isPosInt(dep)) continue // already reported above
      if (dep === m.nexus_id) errors.push(`mod ${m.nexus_id}: requires se stesso`)
      else if (!seen.has(dep)) errors.push(`mod ${m.nexus_id}: requires ${dep} assente nel catalogo`)
    }
    for (const c of m.conflicts_with ?? []) {
      if (!isPosInt(c)) continue // already reported above
      if (c === m.nexus_id) errors.push(`mod ${m.nexus_id}: conflicts_with se stesso`)
      else if (!seen.has(c)) errors.push(`mod ${m.nexus_id}: conflicts_with ${c} assente nel catalogo`)
    }
  }

  return { ok: errors.length === 0, errors }
}
