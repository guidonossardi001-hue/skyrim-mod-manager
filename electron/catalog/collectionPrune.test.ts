import { describe, it, expect } from 'vitest'
import {
  matchCollectionName,
  transitiveRequires,
  computePrunePlan,
  isPruneError,
  type BackupCollectionsLike,
} from './collectionPrune'

// Backup di prova: DOMAIN (1,2,3,4), Altra (3,5). deduped = universo {1,2,3,4,5}.
//  · 3 è CONDIVISA → resta.
//  · 1,2,4 sono esclusive DOMAIN.
//  · la superstite 5 richiede (transitivamente) 2: 5→9→2 → 2 va TENUTA come dipendenza.
const BACKUP: BackupCollectionsLike = {
  collections: [
    { name: 'DOMAIN: An AE NSFW AIO pack by dae', mods: [{ modId: 1 }, { modId: 2 }, { modId: 3 }, { modId: 4 }] },
    { name: 'Altra Collezione', mods: [{ modId: 3 }, { modId: 5 }] },
  ],
  deduped: [{ modId: 1 }, { modId: 2 }, { modId: 3 }, { modId: 4 }, { modId: 5 }],
}
const REQUIRES = new Map<number, number[]>([
  [5, [9]],
  [9, [2]], // catena transitiva: la dipendenza NON è diretta
])

describe('matchCollectionName', () => {
  const names = ['DOMAIN: An AE NSFW AIO pack by dae', 'Mon Skyril', 'MY MODS']
  it('risolve una query parziale case-insensitive quando è univoca', () => {
    expect(matchCollectionName(names, 'domain')).toBe('DOMAIN: An AE NSFW AIO pack by dae')
    expect(matchCollectionName(names, 'mon skyril')).toBe('Mon Skyril')
  })
  it('rifiuta query ambigue o senza match', () => {
    expect(matchCollectionName(names, 'M')).toBeNull() // ambigua (Mon Skyril / MY MODS / DOMAIN)
    expect(matchCollectionName(names, 'inesistente')).toBeNull()
    expect(matchCollectionName(names, '  ')).toBeNull()
  })
})

describe('transitiveRequires', () => {
  it('chiude il grafo, tollera cicli e id sconosciuti', () => {
    const g = new Map<number, number[]>([
      [1, [2]],
      [2, [3, 1]], // ciclo 1↔2
      [3, [99]], // 99 non esiste nel grafo: incluso comunque come richiesto
    ])
    const got = transitiveRequires([1], g)
    expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 99])
  })
})

describe('computePrunePlan', () => {
  it('rimuove solo le esclusive, tiene condivise e dipendenze transitive dei superstiti', () => {
    const plan = computePrunePlan(BACKUP, 'DOMAIN', REQUIRES)
    if (isPruneError(plan)) throw new Error(plan.error)
    expect(plan.collection).toBe('DOMAIN: An AE NSFW AIO pack by dae')
    expect(plan.exclusiveIds.sort()).toEqual([1, 2, 4])
    expect(plan.sharedIds).toEqual([3]) // in DOMAIN ma anche in Altra → resta
    expect(plan.keptAsDependencyIds).toEqual([2]) // 5→9→2: tenuta (no missing masters)
    expect(plan.prunedIds.sort()).toEqual([1, 4])
  })

  it('senza grafo requires: rimuove tutte le esclusive (nessuna dipendenza dichiarata)', () => {
    const plan = computePrunePlan(BACKUP, 'DOMAIN', new Map())
    if (isPruneError(plan)) throw new Error(plan.error)
    expect(plan.prunedIds.sort()).toEqual([1, 2, 4])
    expect(plan.keptAsDependencyIds).toEqual([])
  })

  it('fail-safe: collezione non trovata o backup senza raw → errore, mai un piano azzardato', () => {
    const missing = computePrunePlan(BACKUP, 'SkyUI pack', REQUIRES)
    expect(isPruneError(missing)).toBe(true)
    const noRaw = computePrunePlan({ deduped: [{ modId: 1 }] }, 'DOMAIN', REQUIRES)
    expect(isPruneError(noRaw)).toBe(true)
  })

  it('id malformati nelle raw vengono ignorati senza falsare l’esclusività', () => {
    const dirty: BackupCollectionsLike = {
      collections: [
        { name: 'DOMAIN', mods: [{ modId: 1 }, { modId: Number.NaN }, {}] },
        { name: 'B', mods: [{ modId: -5 }] },
      ],
      deduped: [{ modId: 1 }],
    }
    const plan = computePrunePlan(dirty, 'DOMAIN', new Map())
    if (isPruneError(plan)) throw new Error(plan.error)
    expect(plan.prunedIds).toEqual([1])
  })
})
