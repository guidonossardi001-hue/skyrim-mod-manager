// Masterlist LOOT REALE (community-curata, migliaia di regole) — sostituisce/arricchisce il
// nostro masterlist.json locale (vuoto by design). Fonte: repo pubblico loot/skyrimse, stesso
// file che l'app desktop LOOT scarica. NIENTE binding nativo (node-loot/libloot): è un pacchetto
// non pubblicato su npm nella forma che serve e comunque un addon nativo aggiungerebbe la stessa
// fragilità ABI già sofferta con better-sqlite3/Electron. Il masterlist.yaml è dato pubblico,
// non firmato: trattato come SOFT/informativo (mai un blocco), esattamente come le regole "after"
// del nostro masterlist.json locale — coerente con lootSort che scarta i vincoli soft su ciclo.

import { load as parseYaml } from 'js-yaml'
import type { LootRule } from './lootSort'

const DEFAULT_MASTERLIST_URL = 'https://raw.githubusercontent.com/loot/skyrimse/master/masterlist.yaml'

export interface DirtyEntry {
  /** Nome file o pattern regex dal masterlist (name puo' essere una regex, es. "(No Homes)?..."). */
  pluginPattern: string
  crc: number
  itm: number
  udr: number
  nav: number
  util: string
}

export interface ParsedMasterlist {
  /** Regole "after" dirette (nome->dopo questi altri plugin), stesso shape di masterlist.json. */
  rules: LootRule[]
  /** Rank del gruppo (posizione topologica, 0 = primo) per pattern di nome plugin. */
  groupRankByPattern: { pluginPattern: string; rank: number }[]
  dirty: DirtyEntry[]
  pluginCount: number
  groupCount: number
}

interface RawGroup {
  name?: unknown
  after?: unknown
}
interface RawDirty {
  crc?: unknown
  itm?: unknown
  udr?: unknown
  nav?: unknown
  util?: unknown
}
interface RawPlugin {
  name?: unknown
  group?: unknown
  after?: unknown
  dirty?: unknown
}
interface RawMasterlist {
  groups?: unknown
  plugins?: unknown
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function asInt(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : 0
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

/** Kahn sui gruppi (`after:` punta ai gruppi che devono caricare PRIMA). Ciclo -> ordine parziale
 * per nome (mai un throw: i gruppi sono metadata soft, un ciclo qui non deve rompere il parse). */
function rankGroups(groups: RawGroup[]): Map<string, number> {
  const names = new Set<string>()
  const after = new Map<string, string[]>()
  for (const g of groups) {
    const name = asString(g.name)
    if (!name) continue
    names.add(name)
    after.set(name, asStringArray(g.after))
  }
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const n of names) indegree.set(n, 0)
  for (const n of names) {
    for (const dep of after.get(n) ?? []) {
      if (!names.has(dep)) continue
      indegree.set(n, (indegree.get(n) ?? 0) + 1)
      const list = dependents.get(dep) ?? []
      list.push(n)
      dependents.set(dep, list)
    }
  }
  const rank = new Map<string, number>()
  const ready = [...names].filter((n) => (indegree.get(n) ?? 0) === 0).sort()
  let seq = 0
  while (ready.length) {
    ready.sort()
    const cur = ready.shift()!
    rank.set(cur, seq++)
    for (const dep of dependents.get(cur) ?? []) {
      const left = (indegree.get(dep) ?? 0) - 1
      indegree.set(dep, left)
      if (left === 0) ready.push(dep)
    }
  }
  // Nodi residui (ciclo): rank in coda, ordine per nome — mai un throw su dati community.
  for (const n of [...names].sort()) if (!rank.has(n)) rank.set(n, seq++)
  return rank
}

/** Parse difensivo del masterlist.yaml (js-yaml risolve anchor/alias/merge-key nativamente).
 * Forma inattesa/YAML rotto -> masterlist vuoto, mai un throw: è dato informativo, non critico. */
export function parseMasterlistYaml(yamlText: string): ParsedMasterlist {
  let doc: RawMasterlist
  try {
    doc = (parseYaml(yamlText) ?? {}) as RawMasterlist
  } catch {
    return { rules: [], groupRankByPattern: [], dirty: [], pluginCount: 0, groupCount: 0 }
  }
  const rawGroups = Array.isArray(doc.groups) ? (doc.groups as RawGroup[]) : []
  const groupRank = rankGroups(rawGroups)

  const rawPlugins = Array.isArray(doc.plugins) ? (doc.plugins as RawPlugin[]) : []
  const rules: LootRule[] = []
  const groupRankByPattern: { pluginPattern: string; rank: number }[] = []
  const dirty: DirtyEntry[] = []

  for (const p of rawPlugins) {
    const name = asString(p.name)
    if (!name) continue

    const after = asStringArray(p.after)
    if (after.length) rules.push({ plugin: name, after })

    const group = asString(p.group)
    if (group && groupRank.has(group)) groupRankByPattern.push({ pluginPattern: name, rank: groupRank.get(group)! })

    if (Array.isArray(p.dirty)) {
      for (const d of p.dirty as RawDirty[]) {
        const crcRaw = d.crc
        const crc =
          typeof crcRaw === 'number'
            ? crcRaw >>> 0
            : typeof crcRaw === 'string'
              ? Number.parseInt(crcRaw.replace(/^0x/i, ''), 16) >>> 0
              : NaN
        if (!Number.isFinite(crc)) continue
        const util = asString(d.util) ?? 'SSEEdit'
        dirty.push({ pluginPattern: name, crc, itm: asInt(d.itm), udr: asInt(d.udr), nav: asInt(d.nav), util })
      }
    }
  }

  return {
    rules,
    groupRankByPattern,
    dirty,
    pluginCount: rawPlugins.length,
    groupCount: rawGroups.length,
  }
}

/**
 * Un pattern del masterlist combacia con un nome plugin reale: uguaglianza case-insensitive,
 * oppure regex se il pattern contiene metacaratteri (molte entry del masterlist coprono varianti
 * di nome con una regex, es. "Skyrim Project Optimization - (No Homes - )?Full( ESL)? Version\.esm").
 * Regex invalida o pattern vuoto -> nessun match, mai un throw (dato community non fidato).
 */
export function matchesPluginPattern(pattern: string, realName: string): boolean {
  if (!pattern) return false
  if (pattern.toLowerCase() === realName.toLowerCase()) return true
  if (!/[.*+?^${}()|[\]\\]/.test(pattern)) return false // nessun metacarattere: era un confronto letterale, già escluso sopra
  try {
    return new RegExp(`^${pattern}$`, 'i').test(realName)
  } catch {
    return false
  }
}

export interface HttpGetText {
  (url: string, cfg: { signal?: AbortSignal }): Promise<{ status?: number; data: string }>
}

export class MasterlistFetchError extends Error {}

/** Scarica il masterlist.yaml pubblico (nessuna firma: dato soft, verificato solo via HTTPS/TLS). */
export async function fetchMasterlistYaml(
  http: HttpGetText,
  opts: { url?: string; signal?: AbortSignal } = {},
): Promise<string> {
  try {
    const res = await http(opts.url ?? DEFAULT_MASTERLIST_URL, { signal: opts.signal })
    if (typeof res.data !== 'string' || !res.data.trim())
      throw new MasterlistFetchError('Risposta vuota dal masterlist LOOT')
    return res.data
  } catch (e) {
    if (e instanceof MasterlistFetchError) throw e
    throw new MasterlistFetchError(`Download masterlist LOOT fallito: ${(e as Error).message}`)
  }
}
