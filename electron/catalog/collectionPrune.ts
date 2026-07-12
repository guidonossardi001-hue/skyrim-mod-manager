// Pruning di una collezione dal parco mod (es. "DOMAIN"). PURO: il piano è calcolato su dati
// iniettati (backup + grafo requires), quindi è unit-testabile e il chiamante decide come
// applicarlo (DELETE su modlist_catalog/downloads + filtro della sorgente sync).
//
// Regole di sicurezza del piano:
//   • L'appartenenza si valuta sulle collezioni RAW del backup (non sul campo `collection` del
//     deduped, che attribuisce UNA sola collezione al vincitore del dedup): una mod si rimuove
//     solo se è ESCLUSIVA della collezione target — se compare anche in un'altra collezione
//     resta (le altre liste la usano ancora).
//   • Dependency-keep: una mod esclusiva della collezione ma richiesta (transitivamente, via
//     grafo `requires` del catalogo) da una mod superstite NON si rimuove — la potatura non deve
//     creare "missing masters" nel load order residuo.

export interface BackupCollectionsLike {
  collections?: Array<{ name?: string; mods?: Array<{ modId?: number }> }>
  deduped?: Array<{ modId: number; collection?: string }>
}

export interface PrunePlan {
  /** Nome completo della collezione risolta dalla query (match case-insensitive). */
  collection: string
  /** Mod presenti SOLO nella collezione target (candidate alla rimozione). */
  exclusiveIds: number[]
  /** Mod della collezione presenti anche altrove → mantenute. */
  sharedIds: number[]
  /** Esclusive ma richieste (transitivamente) da una superstite → mantenute (no missing masters). */
  keptAsDependencyIds: number[]
  /** Rimozione effettiva: esclusive − dipendenze mantenute. */
  prunedIds: number[]
}

/** Risolve una query utente ("DOMAIN") nel nome completo della collezione. Match esatto
 *  case-insensitive, altrimenti UNICO match per prefisso/substring; ambiguo o assente → null. */
export function matchCollectionName(names: string[], query: string): string | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const exact = names.find((n) => n.toLowerCase() === q)
  if (exact) return exact
  const partial = names.filter((n) => n.toLowerCase().includes(q))
  return partial.length === 1 ? partial[0] : null
}

/** Chiusura transitiva del grafo `requires` a partire dai semi. Iterativa (niente stack ricorsivo
 *  su 4k+ nodi), tollera id sconosciuti e cicli. */
export function transitiveRequires(seedIds: Iterable<number>, requiresOf: Map<number, number[]>): Set<number> {
  const seen = new Set<number>()
  const stack = [...seedIds]
  while (stack.length) {
    const id = stack.pop() as number
    for (const dep of requiresOf.get(id) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
  return seen
}

export function computePrunePlan(
  backup: BackupCollectionsLike,
  collectionQuery: string,
  requiresOf: Map<number, number[]>,
): PrunePlan | { error: string } {
  const collections = (backup.collections ?? []).filter((c) => c?.name && Array.isArray(c.mods))
  const names = collections.map((c) => c.name as string)
  const target = matchCollectionName(names, collectionQuery)
  if (!target) {
    return {
      error: names.length
        ? `Collezione "${collectionQuery}" non trovata o ambigua. Disponibili: ${names.join(' · ')}`
        : 'Backup senza collezioni raw: impossibile calcolare l’esclusività in sicurezza.',
    }
  }

  const inTarget = new Set<number>()
  const inOthers = new Set<number>()
  for (const c of collections) {
    const bucket = c.name === target ? inTarget : inOthers
    for (const m of c.mods ?? []) {
      const id = Number(m?.modId)
      if (Number.isInteger(id) && id > 0) bucket.add(id)
    }
  }

  // Universo = lista deduped (ciò che davvero entra nella pipeline), non le raw.
  const universe = (backup.deduped ?? [])
    .map((m) => Number(m?.modId))
    .filter((id) => Number.isInteger(id) && id > 0)

  const exclusiveIds: number[] = []
  const sharedIds: number[] = []
  const survivors: number[] = []
  for (const id of universe) {
    if (inTarget.has(id) && !inOthers.has(id)) exclusiveIds.push(id)
    else {
      survivors.push(id)
      if (inTarget.has(id)) sharedIds.push(id)
    }
  }

  // Dipendenze transitive dei superstiti: le esclusive raggiunte vanno TENUTE.
  const needed = transitiveRequires(survivors, requiresOf)
  const keptAsDependencyIds = exclusiveIds.filter((id) => needed.has(id))
  const kept = new Set(keptAsDependencyIds)
  const prunedIds = exclusiveIds.filter((id) => !kept.has(id))

  return { collection: target, exclusiveIds, sharedIds, keptAsDependencyIds, prunedIds }
}

export function isPruneError(p: PrunePlan | { error: string }): p is { error: string } {
  return 'error' in p
}
