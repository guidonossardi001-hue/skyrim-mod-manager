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
import type { HttpGetJson } from './downloadLink'

export interface JsonResponse {
  status?: number
  data: unknown
}
export type HttpPostJson = (
  url: string,
  body: unknown,
  cfg: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<JsonResponse>

const API_ORIGIN = 'https://api.nexusmods.com'
const GRAPHQL_URL = `${API_ORIGIN}/v2/graphql`

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
 * Estrae lo slug da uno slug nudo o da un URL pagina collezione, in TUTTI i formati reali:
 *   • vecchio:  nexusmods.com/skyrimspecialedition/collections/<slug>[/revisions/<n>]
 *   • nuovo:    nexusmods.com/games/skyrimspecialedition/collections/<slug>  (segmento games/)
 *   • next:     next.nexusmods.com/skyrimspecialedition/collections/<slug>
 * Ritorna anche il numero di revisione se presente nell'URL. null = input non riconoscibile.
 */
export function parseCollectionInput(input: string): { slug: string; revision: number | null } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const urlMatch = trimmed.match(
    /nexusmods\.com\/(?:games\/)?[^/]+\/collections\/([a-z0-9]+)(?:\/revisions\/(\d+))?/i,
  )
  if (urlMatch) return { slug: urlMatch[1], revision: urlMatch[2] ? Number(urlMatch[2]) : null }
  // Slug nudo: alfanumerico. Tollera delimitatori copiati per sbaglio attorno (backtick,
  // parentesi, virgolette): si spogliano i bordi non alfanumerici e si valida il nucleo.
  const bare = trimmed.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9]+$/i, '')
  if (bare && /^[a-z0-9]+$/i.test(bare)) return { slug: bare, revision: null }
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
      // `sizeInBytes` è il valore in BYTE (stringa BigInt); `size` è in KB (eredità API v1).
      // Prima si preferiva `size` leggendolo come byte: ogni stima pesava 1024 volte meno.
      const inBytes = Number(m.file?.sizeInBytes)
      const sizeBytes =
        Number.isFinite(inBytes) && inBytes > 0
          ? inBytes
          : typeof m.file?.size === 'number' && m.file.size > 0
            ? m.file.size * 1024
            : 0
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

/**
 * Il graph NON ritorna un URL scaricabile: `downloadLink` è un path RELATIVO all'origin API
 * ("/v2/collections/<id>/revisions/<id>/download_link"). Il client ufficiale lo concatena a
 * BASE_URL (`param.BASE_URL + downloadLink`) — qui la stessa risoluzione, che lascia intatto
 * un eventuale link già assoluto. Rifiuta host fuori da nexusmods.com: il valore diventa una
 * URL a cui inviamo la API key, quindi non basta che arrivi da una fonte fidata.
 */
export function resolveRevisionLinkUrl(link: string): string {
  let url: URL
  try {
    url = new URL(link, API_ORIGIN)
  } catch {
    throw new CollectionFetchError(`downloadLink della revision non interpretabile: "${link}"`)
  }
  if (url.protocol !== 'https:' || !/(^|\.)nexusmods\.com$/i.test(url.hostname))
    throw new CollectionFetchError(`downloadLink della revision non attendibile: "${link}"`)
  return url.toString()
}

/**
 * L'endpoint download_link della revision NON risponde come il v1 dei file di mod (array nudo
 * di { URI, name, short_name }): ritorna un OGGETTO { download_links: [...] } oppure
 * { download_link: {...} } (client ufficiale: `res.download_links ?? [res.download_link]`).
 * Accetta entrambi, più l'array nudo, così un allineamento dell'API al formato v1 non rompe nulla.
 */
export function parseCollectionDownloadUrl(data: unknown): string {
  const d = data as { download_links?: unknown; download_link?: unknown } | null
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(d?.download_links)
      ? d.download_links
      : d?.download_link != null
        ? [d.download_link]
        : []
  for (const e of list) {
    const uri = typeof e === 'string' ? e : (e as { URI?: unknown } | null)?.URI
    if (typeof uri === 'string' && /^https?:\/\//i.test(uri)) return uri
  }
  throw new CollectionFetchError("Risposta Nexus priva di un URI per l'archivio della revision")
}

/**
 * URL CDN dell'ARCHIVIO della revision (contiene collection.json con le scelte FOMOD del
 * curatore — non esposte dal graph sui modFiles). Due passi, come il client ufficiale:
 * graph → downloadLink relativo → GET dell'endpoint download_link → URI del CDN.
 */
export async function fetchRevisionDownloadLink(
  http: HttpPostJson,
  httpGet: HttpGetJson,
  opts: { slug: string; revision?: number | null; apiKey: string; signal?: AbortSignal },
): Promise<string> {
  if (!opts.apiKey?.trim()) throw new CollectionFetchError('Nessuna API key Nexus configurata')
  const hasRevision = typeof opts.revision === 'number' && opts.revision > 0
  const decl = hasRevision ? '($slug: String!, $revision: Int, $adult: Boolean)' : '($slug: String!, $adult: Boolean)'
  const args = hasRevision
    ? 'slug: $slug, revision: $revision, viewAdultContent: $adult'
    : 'slug: $slug, viewAdultContent: $adult'
  const variables: Record<string, unknown> = { slug: opts.slug, adult: true }
  if (hasRevision) variables.revision = opts.revision
  try {
    const res = await http(
      GRAPHQL_URL,
      { query: `query RevLink${decl} { collectionRevision(${args}) { downloadLink } }`, variables },
      {
        headers: { apikey: opts.apiKey, 'Content-Type': 'application/json', 'User-Agent': 'SkyrimAEModManager/1.0' },
        signal: opts.signal,
      },
    )
    const body = res.data as {
      data?: { collectionRevision?: { downloadLink?: unknown } | null }
      errors?: { message?: string }[]
    }
    const rev = body?.data?.collectionRevision
    if (!rev) {
      // Gli errori GraphQL viaggiano con HTTP 200 e `data: null`: senza leggerli qui, un
      // "Collection not found" diventava un generico "downloadLink non disponibile".
      const msg = body?.errors?.map((e) => e.message).filter(Boolean).join('; ')
      throw new CollectionFetchError(msg || `Revision della collezione "${opts.slug}" non trovata`, 404)
    }
    if (typeof rev.downloadLink !== 'string' || !rev.downloadLink.trim())
      throw new CollectionFetchError('downloadLink della revision non disponibile dal graph')
    const dl = await httpGet(resolveRevisionLinkUrl(rev.downloadLink), {
      headers: { apikey: opts.apiKey, Accept: 'application/json', 'User-Agent': 'SkyrimAEModManager/1.0' },
      signal: opts.signal,
    })
    return parseCollectionDownloadUrl(dl.data)
  } catch (e) {
    if (e instanceof CollectionFetchError) throw e
    const status = httpStatusOf(e)
    if (status === 401) throw new CollectionFetchError('API key Nexus non valida (401)', status)
    if (status === 403)
      throw new CollectionFetchError(
        "Accesso negato (403) all'archivio della revision: collezione privata, per adulti o non tua",
        status,
      )
    if (status === 404)
      throw new CollectionFetchError(`Archivio della revision "${opts.slug}" non trovato (404)`, status)
    if (status === 429)
      throw new CollectionFetchError('Limite richieste Nexus superato (429): riprova più tardi', status)
    throw new CollectionFetchError(
      `Recupero archivio della revision fallito${status ? ` (HTTP ${status})` : ''}: ${(e as Error).message}`,
      status,
    )
  }
}

/**
 * Mappa una collezione già recuperata in righe modlist_catalog (stesso shape dell'import Vortex).
 * UNA RIGA PER FILE, non per mod: 156 mod della collection reale hanno più file required
 * (main + patch ESL/USSEP, o addirittura main + suoi addon — es. Beyond Skyrim Bruma), e la
 * vecchia dedup per modId ne buttava 200 tenendo un file arbitrario (a volte la patch senza
 * il master → missing masters al lancio). La dedup è per coppia (modId, fileId); nomi duplicati
 * DENTRO lo stesso mod vengono disambiguati col fileId perché il nome diventa la cartella di
 * estrazione `<nexus_id>-<nome>` (collisione = il secondo install sostituirebbe il primo).
 */
export function buildCatalogRowsFromCollection(result: CollectionRevisionResult): CatalogRow[] {
  const seen = new Set<string>()
  const nameCount = new Map<string, number>()
  for (const m of result.mods) {
    const k = `${m.modId} ${m.name.toLowerCase()}`
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1)
  }
  const rows: CatalogRow[] = []
  for (const m of result.mods) {
    const pair = `${m.modId}:${m.fileId}`
    if (seen.has(pair)) continue
    seen.add(pair)
    const dupName = (nameCount.get(`${m.modId} ${m.name.toLowerCase()}`) ?? 0) > 1
    rows.push({
      nexus_id: m.modId,
      nexus_file_id: m.fileId,
      name: (dupName ? `${m.name} (file ${m.fileId})` : m.name).slice(0, 300),
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
