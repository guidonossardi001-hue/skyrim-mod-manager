import { describe, it, expect } from 'vitest'
import {
  parseCollectionInput,
  fetchCollectionRevision,
  fetchRevisionDownloadLink,
  resolveRevisionLinkUrl,
  parseCollectionDownloadUrl,
  buildCatalogRowsFromCollection,
  CollectionFetchError,
  NEXUS_COLLECTION_IMPORT_NOTE,
  type HttpPostJson,
  type CollectionRevisionResult,
} from './collections'
import type { HttpGetJson } from './downloadLink'

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
  it('accetta il formato URL NUOVO col segmento games/ (il caso reale che falliva)', () => {
    expect(
      parseCollectionInput('https://www.nexusmods.com/games/skyrimspecialedition/collections/frkafa'),
    ).toEqual({ slug: 'frkafa', revision: null })
    expect(
      parseCollectionInput('https://next.nexusmods.com/skyrimspecialedition/collections/abc123'),
    ).toEqual({ slug: 'abc123', revision: null })
  })
  it('accetta uno slug nudo, anche con delimitatori copiati attorno', () => {
    expect(parseCollectionInput('abc123')).toEqual({ slug: 'abc123', revision: null })
    expect(parseCollectionInput('`frkafa`')).toEqual({ slug: 'frkafa', revision: null })
    expect(parseCollectionInput('[frkafa]')).toEqual({ slug: 'frkafa', revision: null })
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
    // `size` è in KB (eredità API v1): 51200 KB = 52428800 byte. `sizeInBytes` è il valore esatto.
    { fileId: 111, optional: false, version: '1.0', file: { modId: 266, fileId: 111, name: 'USSEP', size: 51200 } },
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

  it('estrae modId/fileId/size correttamente: sizeInBytes (byte esatti) preferito, `size` interpretato in KB', async () => {
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

describe('resolveRevisionLinkUrl', () => {
  it('risolve il path RELATIVO del graph sull origin API (il caso reale che falliva)', () => {
    expect(resolveRevisionLinkUrl('/v2/collections/431896/revisions/735856/download_link')).toBe(
      'https://api.nexusmods.com/v2/collections/431896/revisions/735856/download_link',
    )
  })
  it('lascia intatto un link gia assoluto su nexusmods.com', () => {
    expect(resolveRevisionLinkUrl('https://api.nexusmods.com/v2/x/download_link')).toBe(
      'https://api.nexusmods.com/v2/x/download_link',
    )
  })
  it('rifiuta host esterni e schemi non https (la API key viaggia su questa URL)', () => {
    expect(() => resolveRevisionLinkUrl('https://evil.example.com/steal')).toThrow(/non attendibile/)
    expect(() => resolveRevisionLinkUrl('http://api.nexusmods.com/v2/x')).toThrow(/non attendibile/)
    expect(() => resolveRevisionLinkUrl('https://nexusmods.com.evil.example.com/x')).toThrow(/non attendibile/)
  })
})

describe('parseCollectionDownloadUrl', () => {
  it('legge { download_links: [...] } (formato reale della revision)', () => {
    expect(
      parseCollectionDownloadUrl({ download_links: [{ URI: 'https://cdn.nexusmods.com/a.7z', name: 'CDN' }] }),
    ).toBe('https://cdn.nexusmods.com/a.7z')
  })
  it('legge il singolare { download_link: {...} } e larray nudo in stile v1', () => {
    expect(parseCollectionDownloadUrl({ download_link: { URI: 'https://cdn.nexusmods.com/b.7z' } })).toBe(
      'https://cdn.nexusmods.com/b.7z',
    )
    expect(parseCollectionDownloadUrl([{ URI: 'https://cdn.nexusmods.com/c.7z' }])).toBe(
      'https://cdn.nexusmods.com/c.7z',
    )
  })
  it('salta le voci senza URI usabile, poi fallisce', () => {
    expect(parseCollectionDownloadUrl({ download_links: [{ name: 'no uri' }, { URI: 'https://cdn.nexusmods.com/d.7z' }] })).toBe(
      'https://cdn.nexusmods.com/d.7z',
    )
    expect(() => parseCollectionDownloadUrl({ download_links: [] })).toThrow(/priva di un URI/)
    expect(() => parseCollectionDownloadUrl(null)).toThrow(/priva di un URI/)
  })
})

describe('fetchRevisionDownloadLink', () => {
  const linkResponse = (downloadLink: unknown) => ({ status: 200, data: { data: { collectionRevision: { downloadLink } } } })
  const CDN = 'https://cdn.nexusmods.com/collection-431896-159.7z'
  const okGet: HttpGetJson = async () => ({ status: 200, data: { download_links: [{ URI: CDN }] } })

  it('graph relativo → GET download_link → URI del CDN, con la API key su entrambi i passi', async () => {
    const seen: { url: string; headers?: Record<string, string>; body?: unknown }[] = []
    const post: HttpPostJson = async (url, body, cfg) => {
      seen.push({ url, headers: cfg.headers, body })
      return linkResponse('/v2/collections/431896/revisions/735856/download_link')
    }
    const get: HttpGetJson = async (url, cfg) => {
      seen.push({ url, headers: cfg.headers })
      return { status: 200, data: { download_links: [{ URI: CDN }] } }
    }
    await expect(fetchRevisionDownloadLink(post, get, { slug: 'frkafa', revision: 159, apiKey: 'k' })).resolves.toBe(CDN)
    expect(seen[0].url).toBe('https://api.nexusmods.com/v2/graphql')
    expect(seen[0].headers?.apikey).toBe('k')
    expect(seen[1].url).toBe('https://api.nexusmods.com/v2/collections/431896/revisions/735856/download_link')
    expect(seen[1].headers?.apikey).toBe('k')
  })

  // La revision NON è decorativa: ometterla fa tornare al graph la revision PIU' RECENTE, e le
  // scelte del curatore finirebbero applicate da una revision diversa da quella importata —
  // silenziosamente. Stessa coppia di test già presente su buildQuery (di cui questa e' una copia).
  it('dichiara $revision quando la collection e pinnata a una revision', async () => {
    let sentBody: unknown
    const post: HttpPostJson = async (_u, body) => {
      sentBody = body
      return linkResponse('/v2/collections/431896/revisions/735856/download_link')
    }
    await fetchRevisionDownloadLink(post, okGet, { slug: 'frkafa', revision: 159, apiKey: 'k' })
    expect((sentBody as { query: string }).query).toContain('$revision')
    expect((sentBody as { variables: Record<string, unknown> }).variables.revision).toBe(159)
  })

  it('non dichiara $revision quando assente (il graph torna la latest)', async () => {
    let sentBody: unknown
    const post: HttpPostJson = async (_u, body) => {
      sentBody = body
      return linkResponse('/v2/collections/431896/revisions/735856/download_link')
    }
    await fetchRevisionDownloadLink(post, okGet, { slug: 'frkafa', revision: null, apiKey: 'k' })
    expect((sentBody as { query: string }).query).not.toContain('$revision')
    expect((sentBody as { variables: Record<string, unknown> }).variables.revision).toBeUndefined()
  })

  it('rifiuta senza API key, senza toccare la rete', async () => {
    const boom: HttpPostJson = async () => {
      throw new Error('non deve essere chiamata')
    }
    await expect(fetchRevisionDownloadLink(boom, okGet, { slug: 'x', apiKey: ' ' })).rejects.toThrow(/API key/)
  })

  it('errore GraphQL (HTTP 200 + data null) riportato col messaggio del graph', async () => {
    const post: HttpPostJson = async () => ({ status: 200, data: { errors: [{ message: 'Collection not found' }] } })
    await expect(fetchRevisionDownloadLink(post, okGet, { slug: 'x', apiKey: 'k' })).rejects.toThrow(
      'Collection not found',
    )
  })

  it('downloadLink vuoto → errore esplicito', async () => {
    const post: HttpPostJson = async () => linkResponse('   ')
    await expect(fetchRevisionDownloadLink(post, okGet, { slug: 'x', apiKey: 'k' })).rejects.toThrow(/non disponibile/)
  })

  it('401/403/429 dellendpoint download_link mappati, preservando lo status', async () => {
    const post: HttpPostJson = async () => linkResponse('/v2/collections/1/revisions/2/download_link')
    const getStatus = (status: number): HttpGetJson => () => Promise.reject({ response: { status } })
    await expect(
      fetchRevisionDownloadLink(post, getStatus(401), { slug: 'x', apiKey: 'k' }),
    ).rejects.toMatchObject({ status: 401 })
    await expect(fetchRevisionDownloadLink(post, getStatus(403), { slug: 'x', apiKey: 'k' })).rejects.toThrow(/negato/)
    await expect(fetchRevisionDownloadLink(post, getStatus(429), { slug: 'x', apiKey: 'k' })).rejects.toThrow(/Limite/)
  })
})

describe('buildCatalogRowsFromCollection', () => {
  const base = {
    collectionName: 'Anime Fantasy',
    collectionSlug: 'abc123',
    revisionNumber: 3,
    modCount: 2,
    gameDomain: 'skyrimspecialedition',
  }

  it('UNA riga per FILE (il caso reale: main + patch ESL dello stesso mod), required=1 salvo optional', () => {
    const result: CollectionRevisionResult = {
      ...base,
      mods: [
        { modId: 266, fileId: 111, name: 'USSEP', version: '1.0', sizeBytes: 52428800, optional: false },
        { modId: 12604, fileId: 222, name: 'SkyUI', version: '2.0', sizeBytes: 10485760, optional: true },
        { modId: 266, fileId: 999, name: 'ESP flagged as ESL', version: '1.1', sizeBytes: 4096, optional: false },
      ],
    }
    const rows = buildCatalogRowsFromCollection(result)
    expect(rows).toHaveLength(3) // il secondo FILE del mod 266 NON viene più scartato
    expect(rows[0]).toMatchObject({ nexus_id: 266, nexus_file_id: 111, name: 'USSEP', required: 1, size_mb: 50 })
    expect(rows[1]).toMatchObject({ nexus_id: 12604, nexus_file_id: 222, required: 0 })
    expect(rows[2]).toMatchObject({ nexus_id: 266, nexus_file_id: 999, name: 'ESP flagged as ESL', required: 1 })
    expect(rows[0].notes).toContain(NEXUS_COLLECTION_IMPORT_NOTE)
    expect(rows[0].notes).toContain('Anime Fantasy')
    expect(rows[0].notes).toContain('rev.3')
  })

  it('dedup sulla COPPIA (modId, fileId): la stessa coppia due volte resta una riga', () => {
    const result: CollectionRevisionResult = {
      ...base,
      mods: [
        { modId: 266, fileId: 111, name: 'USSEP', version: '1.0', sizeBytes: 0, optional: false },
        { modId: 266, fileId: 111, name: 'USSEP bis', version: '1.0', sizeBytes: 0, optional: false },
      ],
    }
    expect(buildCatalogRowsFromCollection(result)).toHaveLength(1)
  })

  it('nomi duplicati DENTRO lo stesso mod disambiguati col fileId (il nome diventa la cartella di estrazione)', () => {
    const result: CollectionRevisionResult = {
      ...base,
      mods: [
        { modId: 5, fileId: 10, name: 'Main File', version: '1', sizeBytes: 0, optional: false },
        { modId: 5, fileId: 20, name: 'Main File', version: '2', sizeBytes: 0, optional: false },
        // stesso nome su un ALTRO mod: nessuna disambiguazione (namespace già dal nexus_id)
        { modId: 6, fileId: 30, name: 'Main File', version: '1', sizeBytes: 0, optional: false },
      ],
    }
    const rows = buildCatalogRowsFromCollection(result)
    expect(rows.map((r) => r.name)).toEqual(['Main File (file 10)', 'Main File (file 20)', 'Main File'])
  })
})
