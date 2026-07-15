// Import di una collezione Nexus (v2 GraphQL) DIRETTAMENTE dalla fonte ufficiale — sostituisce
// il fallback "backup Vortex" per la modlist: qui il modId/fileId di ogni mod arriva dal graph
// server-side, mai da un JSON locale con id storicamente inaffidabili (vedi seed curato:
// nexus_id sbagliati che avevano marcato "installate" le mod sbagliate).
//
// Niente SDK: la libreria ufficiale (@nexusmods/nexus-api) non pubblica ancora su npm il metodo
// collectionRevision usato qui (verificato: il tarball pubblicato 1.1.5 non lo contiene, è solo
// su GitHub master) — installarlo da un ref Git non pubblicato sarebbe una dipendenza instabile
// a runtime del build. Lo schema GraphQL pubblico (v2/graphql) è invece stabile: stessa query
// costruita a mano, stesso pattern già in uso per download_link.json (http-injected, testabile).

import { httpStatusOf } from '../install/retryPolicy'
import type { CatalogRow } from '../catalog/vortexImport'

export interface JsonResponse {
  status?: number
  data: unknown
}
export type HttpPostJson = (
  url: string,
  body: unknown,
  cfg: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<JsonResponse>

const GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql'

// Marker in modlist_catalog.notes: distingue una riga importata da Collection (autoritativa,
// stessa fonte del download reale) da seed curato o import Vortex.
export const NEXUS_COLLECTION_IMPORT_NOTE = 'Importato da Nexus Collection'

export interface CollectionModEntry {
  modId: number
  fileId: number
  name: string
  version: string
  sizeBytes: number
  optional: boolean
}

export interface CollectionRevisionResult {
  collectionName: string
  collectionSlug: string
  revisionNumber: number
  modCount: number
  gameDomain: string | null
  mods: CollectionModEntry[]
}

/**
 * Estrae lo slug da uno slug nudo o da un URL pagina collezione
 * (https://www.nexusmods.com/skyrimspecialedition/collections/<slug>[/revisions/<n>]).
 * Ritorna anche il numero di revisione se presente nell'URL. null = input non riconoscibile.
 */
export function parseCollectionInput(input: string): { slug: string; revision: number | null } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const urlMatch = trimmed.match(/nexusmods\.com\/[^/]+\/collections\/([a-z0-9]+)(?:\/revisions\/(\d+))?/i)
  if (urlMatch) return { slug: urlMatch[1], revision: urlMatch[2] ? Number(urlMatch[2]) : null }
  // Slug nudo: alfanumerico, formato reale Nexus (es. "abc123").
  if (/^[a-z0-9]+$/i.test(trimmed)) return { slug: trimmed, revision: null }
  return null
}

// Query scritta a mano sullo schema pubblico v2/graphql (stessi nomi campo di
// ICollectionRevisionMod/IModFile del client ufficiale). Due varianti: il parametro $revision è
// dichiarato SOLO quando richiesto — passare `revision: null` esplicito a un GraphQL non è
// equivalente a ometterlo, e il client ufficiale lo omette quando l'utente vuole "l'ultima".
function buildQuery(hasRevision: boolean): string {
  const decl = hasRevision
    ? '($slug: String!, $revision: Int, $adult: Boolean)'
    : '($slug: String!, $adult: Boolean)'
  const args = hasRevision
    ? 'slug: $slug, revision: $revision, viewAdultContent: $adult'
    : 'slug: $slug, viewAdultContent: $adult'
  return `query CollectionRevision${decl} {
  collectionRevision(${args}) {
    id
    revisionNumber
    modCount
    collection {
      slug
      name
      game { domainName }
    }
    modFiles {
      fileId
      optional
      version
      file {
        modId
        fileId
        name
        version
        size
        sizeInBytes
      }
    }
  }
}`
}

export class CollectionFetchError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'CollectionFetchError'
    this.status = status
  }
}

export async function fetchCollectionRevision(
  http: HttpPostJson,
  opts: { slug: string; revision?: number | null; apiKey: string; signal?: AbortSignal },
): Promise<CollectionRevisionResult> {
  if (!opts.apiKey?.trim()) throw new CollectionFetchError('Nessuna API key Nexus configurata')
  const hasRevision = typeof opts.revision === 'number' && opts.revision > 0
  const variables: Record<string, unknown> = { slug: opts.slug, adult: true }
  if (hasRevision) variables.revision = opts.revision
  try {
    const res = await http(
      GRAPHQL_URL,
      { query: buildQuery(hasRevision), variables },
      {
        headers: {
          apikey: opts.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': 'SkyrimAEModManager/1.0',
        },
        signal: opts.signal,
      },
    )
    const body = res.data as { data?: { collectionRevision?: unknown }; errors?: { message?: string }[] }
    const rev = body?.data?.collectionRevision as
      | {
          revisionNumber?: number
          modCount?: number
          collection?: { slug?: string; name?: string; game?: { domainName?: string } }
          modFiles?: {
            fileId?: number
            optional?: boolean
            version?: string
            file?: { modId?: number; fileId?: number; name?: string; version?: string; size?: number; sizeInBytes?: string }
          }[]
        }
      | undefined
    if (!rev) {
      const msg = body?.errors?.map((e) => e.message).filter(Boolean).join('; ')
      throw new CollectionFetchError(msg || `Collezione "${opts.slug}" non trovata`, 404)
    }
    const mods: CollectionModEntry[] = []
    for (const m of rev.modFiles ?? []) {
      const modId = m.file?.modId
      const fileId = m.fileId ?? m.file?.fileId
      const name = m.file?.name
      if (typeof modId !== 'number' || modId <= 0) continue
      if (typeof fileId !== 'number' || fileId <= 0) continue
      if (typeof name !== 'string' || !name.trim()) continue
      const sizeBytes = typeof m.file?.size === 'number' && m.file.size > 0 ? m.file.size : Number(m.file?.sizeInBytes) || 0
      mods.push({ modId, fileId, name: name.trim(), version: m.version ?? m.file?.version ?? '', sizeBytes, optional: !!m.optional })
    }
    return {
      collectionName: rev.collection?.name ?? opts.slug,
      collectionSlug: rev.collection?.slug ?? opts.slug,
      revisionNumber: rev.revisionNumber ?? 0,
      modCount: rev.modCount ?? mods.length,
      gameDomain: rev.collection?.game?.domainName ?? null,
      mods,
    }
  } catch (e) {
    if (e instanceof CollectionFetchError) throw e
    const status = httpStatusOf(e)
    if (status === 401) throw new CollectionFetchError('API key Nexus non valida (401)', status)
    if (status === 403)
      throw new CollectionFetchError('Accesso negato (403): collezione privata, per adulti o non tua', status)
    if (status === 404) throw new CollectionFetchError(`Collezione "${opts.slug}" non trovata (404)`, status)
    if (status === 429) throw new CollectionFetchError('Limite richieste Nexus superato (429): riprova più tardi', status)
    throw new CollectionFetchError(`Recupero collezione fallito${status ? ` (HTTP ${status})` : ''}: ${(e as Error).message}`, status)
  }
}

/** Mappa una collezione già recuperata in righe modlist_catalog (stesso shape dell'import Vortex). */
export function buildCatalogRowsFromCollection(result: CollectionRevisionResult): CatalogRow[] {
  const seen = new Set<number>()
  const rows: CatalogRow[] = []
  for (const m of result.mods) {
    if (seen.has(m.modId)) continue
    seen.add(m.modId)
    rows.push({
      nexus_id: m.modId,
      nexus_file_id: m.fileId,
      name: m.name.slice(0, 300),
      category: result.collectionName.slice(0, 100) || 'Collection',
      subcategory: null,
      priority_order: 1000,
      required: m.optional ? 0 : 1,
      description: null,
      author: null,
      tags: '[]',
      size_mb: Math.round(m.sizeBytes / (1024 * 1024)),
      has_it_translation: 0,
      notes: `${NEXUS_COLLECTION_IMPORT_NOTE} "${result.collectionName}" rev.${result.revisionNumber}`,
      conflicts_with: '[]',
      requires: '[]',
    })
  }
  return rows
}
