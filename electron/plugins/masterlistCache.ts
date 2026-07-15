// Cache su disco del masterlist LOOT reale: fetch esplicito (mai automatico al boot — vedi
// [[skyrim-catalog-wiped]], una fetch di rete silenziosa a ogni avvio è la stessa classe di bug
// del vecchio auto-seed) → parse → persistenza JSON in userData. Il deploy legge SOLO la cache
// (mai la rete): un deploy non deve mai dipendere dalla disponibilità di GitHub.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { parseMasterlistYaml, fetchMasterlistYaml, type ParsedMasterlist, type HttpGetText } from './lootMasterlist'

export const MASTERLIST_CACHE_FILE = 'loot-masterlist-cache.json'

export interface MasterlistCache extends ParsedMasterlist {
  fetchedAt: string // ISO timestamp
  sourceUrl: string
}

const EMPTY: ParsedMasterlist = { rules: [], groupRankByPattern: [], dirty: [], pluginCount: 0, groupCount: 0 }

/** Legge la cache dal path dato. Assente/corrotta -> masterlist vuoto (fail-soft, mai un throw:
 * il deploy deve procedere anche senza masterlist LOOT, con i soli master reali). */
export function loadMasterlistCache(path: string | null | undefined): MasterlistCache | null {
  if (!path) return null
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MasterlistCache>
    if (!Array.isArray(parsed.rules) || !Array.isArray(parsed.dirty) || !Array.isArray(parsed.groupRankByPattern))
      return null
    return {
      rules: parsed.rules,
      groupRankByPattern: parsed.groupRankByPattern,
      dirty: parsed.dirty,
      pluginCount: typeof parsed.pluginCount === 'number' ? parsed.pluginCount : 0,
      groupCount: typeof parsed.groupCount === 'number' ? parsed.groupCount : 0,
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
      sourceUrl: typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : '',
    }
  } catch {
    return null
  }
}

/** Scarica + parse + scrive la cache. Non tocca il disco su fetch fallita (la cache precedente,
 * se esiste, resta valida). `now` iniettato per restare puro/testabile (Date.now() vietato negli
 * script del genere, ma qui serve comunque un valore — il chiamante lo passa esplicitamente). */
export async function refreshMasterlistCache(
  http: HttpGetText,
  cachePath: string,
  opts: { url?: string; nowIso: string; signal?: AbortSignal },
): Promise<MasterlistCache> {
  const yamlText = await fetchMasterlistYaml(http, { url: opts.url, signal: opts.signal })
  const parsed = parseMasterlistYaml(yamlText)
  const cache: MasterlistCache = {
    ...parsed,
    fetchedAt: opts.nowIso,
    sourceUrl: opts.url ?? 'https://raw.githubusercontent.com/loot/skyrimse/master/masterlist.yaml',
  }
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8')
  return cache
}

/** Merge di due masterlist (es. cache LOOT + eventuali regole locali future): concatena rules,
 * groupRankByPattern e dirty senza dedup (i consumer — lootSort/dirtyPluginCheck — sono già
 * tolleranti a entry ridondanti: prima wins su lootup lineare, o unione su lootSort). */
export function mergeMasterlists(a: ParsedMasterlist | null, b: ParsedMasterlist | null): ParsedMasterlist {
  const x = a ?? EMPTY
  const y = b ?? EMPTY
  return {
    rules: [...x.rules, ...y.rules],
    groupRankByPattern: [...x.groupRankByPattern, ...y.groupRankByPattern],
    dirty: [...x.dirty, ...y.dirty],
    pluginCount: x.pluginCount + y.pluginCount,
    groupCount: x.groupCount + y.groupCount,
  }
}
