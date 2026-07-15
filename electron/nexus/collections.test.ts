import { describe, it, expect } from 'vitest'
import {
  parseCollectionInput,
  fetchCollectionRevision,
  buildCatalogRowsFromCollection,
  CollectionFetchError,
  NEXUS_COLLECTION_IMPORT_NOTE,
  type HttpPostJson,
  type CollectionRevisionResult,
} from './collections'

describe('parseCollectionInput', () => {
  it('estrae slug e revisione da un URL pagina collezione', () => {
    expect(parseCollectionInput('https://www.nexusmods.com/skyrimspecialedition/collections/abc123')).toEqual({
      slug: 'abc123',
      revision: null,
    })
    expect(
      parseCollectionInput('https://www.nexusmods.com/skyrimspecialedition/collections/abc123/revisions/7'),
    ).toEqual({ slug: 'abc123', revision: 7 })
  })
  it('accetta uno slug nudo', () => {
    expect(parseCollectionInput('abc123')).toEqual({ slug: 'abc123', revision: null })
  })
  it('null per input vuoto o irriconoscibile', () => {
    expect(parseCollectionInput('')).toBeNull()
    expect(parseCollectionInput('   ')).toBeNull()
    expect(parseCollectionInput('https://example.com/nope')).toBeNull()
    expect(parseCollectionInput('con spazi dentro')).toBeNull()
  })
})

const graphQLResponse = (collectionRevision: unknown) => ({ status: 200, data: { data: { collectionRevision } } })

const REV = {
  revisionNumber: 3,
  modCount: 2,
  collection: { slug: 'abc123', name: 'Anime Fantasy', game: { domainName: 'skyrimspecialedition' } },
  modFiles: [
    { fileId: 111, optional: false, version: '1.0', file: { modId: 266, fileId: 111, name: 'USSEP', size: 52428800 } },
    { fileId: 222, optional: true, version: '2.0', file: { modId: 12604, fileId: 222, name: 'SkyUI', sizeInBytes: '10485760' } },
  ],
}

describe('fetchCollectionRevision', () => {
  it('mappa la risposta GraphQL in mod entries, rifiuta senza API key', async () => {
    await expect(
      fetchCollectionRevision((() => Promise.resolve(graphQLResponse(REV))) as HttpPostJson, {
        slug: 'abc123',
        apiKey: '',
      }),
    ).rejects.toThrow(/API key/)
  })

  it('estrae modId/fileId/size correttamente, incluso il fallback sizeInBytes', async () => {
    const http: HttpPostJson = async () => graphQLResponse(REV)
    const res = await fetchCollectionRevision(http, { slug: 'abc123', apiKey: 'k' })
    expect(res.collectionName).toBe('Anime Fantasy')
    expect(res.revisionNumber).toBe(3)
    expect(res.gameDomain).toBe('skyrimspecialedition')
    expect(res.mods).toEqual([
      { modId: 266, fileId: 111, name: 'USSEP', version: '1.0', sizeBytes: 52428800, optional: false },
      { modId: 12604, fileId: 222, name: 'SkyUI', version: '2.0', sizeBytes: 10485760, optional: true },
    ])
  })

  it('non dichiara $revision quando omessa (query senza parametro)', async () => {
    let sentBody: unknown
    const http: HttpPostJson = async (_url, body) => {
      sentBody = body
      return graphQLResponse(REV)
    }
    await fetchCollectionRevision(http, { slug: 'abc123', apiKey: 'k' })
    expect((sentBody as { query: string }).query).not.toContain('$revision')
    expect((sentBody as { variables: Record<string, unknown> }).variables.revision).toBeUndefined()
  })

  it('dichiara $revision quando richiesta esplicitamente', async () => {
    let sentBody: unknown
    const http: HttpPostJson = async (_url, body) => {
      sentBody = body
      return graphQLResponse(REV)
    }
    await fetchCollectionRevision(http, { slug: 'abc123', revision: 7, apiKey: 'k' })
    expect((sentBody as { query: string }).query).toContain('$revision')
    expect((sentBody as { variables: Record<string, unknown> }).variables.revision).toBe(7)
  })

  it('scarta mod entries con modId/fileId/name mancanti o invalidi', async () => {
    const dirty = {
      ...REV,
      modFiles: [
        { fileId: 1, optional: false, version: '1', file: { modId: 0, fileId: 1, name: 'X' } }, // modId invalido
        { fileId: 0, optional: false, version: '1', file: { modId: 5, name: 'Y' } }, // fileId assente
        { fileId: 9, optional: false, version: '1', file: { modId: 5, fileId: 9, name: '  ' } }, // nome vuoto
        { fileId: 10, optional: false, version: '1', file: { modId: 5, fileId: 10, name: 'Valida' } },
      ],
    }
    const http: HttpPostJson = async () => graphQLResponse(dirty)
    const res = await fetchCollectionRevision(http, { slug: 'abc123', apiKey: 'k' })
    expect(res.mods).toEqual([{ modId: 5, fileId: 10, name: 'Valida', version: '1', sizeBytes: 0, optional: false }])
  })

  it('collectionRevision assente → errore con messaggio GraphQL o fallback', async () => {
    const http: HttpPostJson = async () => ({ status: 200, data: { errors: [{ message: 'not found' }] } })
    await expect(fetchCollectionRevision(http, { slug: 'abc123', apiKey: 'k' })).rejects.toThrow('not found')
  })

  it('401/403/404/429 mappati a messaggi azionabili, preservando lo status', async () => {
    const withStatus = (status: number): HttpPostJson => () => Promise.reject({ response: { status } })
    await expect(fetchCollectionRevision(withStatus(401), { slug: 'x', apiKey: 'k' })).rejects.toMatchObject({
      status: 401,
    })
    await expect(fetchCollectionRevision(withStatus(403), { slug: 'x', apiKey: 'k' })).rejects.toThrow(/negato/)
    await expect(fetchCollectionRevision(withStatus(404), { slug: 'x', apiKey: 'k' })).rejects.toThrow(/non trovata/)
    await expect(fetchCollectionRevision(withStatus(429), { slug: 'x', apiKey: 'k' })).rejects.toThrow(/Limite/)
  })

  it('CollectionFetchError espone lo status', () => {
    const e = new CollectionFetchError('boom', 500)
    expect(e.status).toBe(500)
    expect(e.name).toBe('CollectionFetchError')
  })
})

describe('buildCatalogRowsFromCollection', () => {
  it('mappa in righe modlist_catalog, required=1 salvo optional, dedup su modId', () => {
    const result: CollectionRevisionResult = {
      collectionName: 'Anime Fantasy',
      collectionSlug: 'abc123',
      revisionNumber: 3,
      modCount: 2,
      gameDomain: 'skyrimspecialedition',
      mods: [
        { modId: 266, fileId: 111, name: 'USSEP', version: '1.0', sizeBytes: 52428800, optional: false },
        { modId: 12604, fileId: 222, name: 'SkyUI', version: '2.0', sizeBytes: 10485760, optional: true },
        { modId: 266, fileId: 999, name: 'USSEP dup', version: '1.1', sizeBytes: 0, optional: false },
      ],
    }
    const rows = buildCatalogRowsFromCollection(result)
    expect(rows).toHaveLength(2) // il modId 266 duplicato è scartato
    expect(rows[0]).toMatchObject({ nexus_id: 266, nexus_file_id: 111, name: 'USSEP', required: 1, size_mb: 50 })
    expect(rows[1]).toMatchObject({ nexus_id: 12604, nexus_file_id: 222, required: 0 })
    expect(rows[0].notes).toContain(NEXUS_COLLECTION_IMPORT_NOTE)
    expect(rows[0].notes).toContain('Anime Fantasy')
    expect(rows[0].notes).toContain('rev.3')
  })
})
