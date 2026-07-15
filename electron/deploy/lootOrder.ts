// Adapter LOOT-like per il deploy: header TES4 reali (espParser) + fallback catalogo
// → lootSort → PluginEntry riprioritizzati per buildPluginsTxt.
//
// Sostituisce l'ordinamento solo-catalogo (orderPluginsByDependencies): i master veri
// letti dal binario del plugin vincono SEMPRE sulla stima `requires` del catalogo, che
// resta il fallback per i soli plugin con header illeggibile (o senza src noto — i
// dummy dei test). Missing master = blocco (il gioco crasherebbe al load).

import { readPluginHeader, isMasterSpace, type PluginHeader } from '../plugins/espParser'
import { lootSort, type LootPlugin, type LootRule } from '../plugins/lootSort'
import { BASE_MASTERS, type PluginEntry } from './plan'

export type LootOrderResult =
  | { ok: true; plugins: PluginEntry[]; warnings: string[] }
  | { ok: false; kind: 'dependency-cycle'; cycle: string[]; warnings: string[] }
  | {
      ok: false
      kind: 'missing-master'
      missing: { plugin: string; masters: string[] }[]
      warnings: string[]
    }

export function orderPluginsLoot(
  planPlugins: PluginEntry[],
  nexusIdOf: Map<string, number>, // providing-mod name → nexus_id
  requires: Map<number, number[]>, // grafo requires del catalogo (nexus_id → deps)
  opts: {
    externalMasters?: string[] // plugin fuori dal deploy (Creation Club dello StockGame)
    rules?: LootRule[] // masterlist-lite opzionale
    readHeader?: (path: string) => PluginHeader | null // iniettabile nei test
  } = {},
): LootOrderResult {
  if (!planPlugins.length) return { ok: true, plugins: [], warnings: [] }
  const read = opts.readHeader ?? readPluginHeader

  // Fallback catalogo a livello MOD: dep nexus_id → mod interne al deploy → i loro plugin.
  const pluginsOfMod = new Map<string, string[]>()
  for (const p of planPlugins) {
    const list = pluginsOfMod.get(p.mod) ?? []
    list.push(p.name)
    pluginsOfMod.set(p.mod, list)
  }
  const modByNexus = new Map<number, string>()
  for (const [mod, id] of nexusIdOf) if (pluginsOfMod.has(mod)) modByNexus.set(id, mod)
  const fallbackAfterOf = (mod: string): string[] => {
    const id = nexusIdOf.get(mod)
    if (id == null) return []
    const names: string[] = []
    for (const depId of requires.get(id) ?? []) {
      const depMod = modByNexus.get(depId)
      if (depMod && depMod !== mod) names.push(...(pluginsOfMod.get(depMod) ?? []))
    }
    return names
  }

  const headerOf = new Map<string, PluginHeader | null>()
  const lootPlugins: LootPlugin[] = planPlugins.map((p) => {
    const header = p.src ? read(p.src) : null
    headerOf.set(p.name, header)
    return {
      name: p.name,
      priority: p.priority,
      masterSpace: isMasterSpace(p.name, header),
      masters: header?.masters ?? null,
      fallbackAfter: header ? undefined : fallbackAfterOf(p.mod),
    }
  })

  const outcome = lootSort(lootPlugins, {
    externalMasters: [...BASE_MASTERS, ...(opts.externalMasters ?? [])],
    rules: opts.rules,
  })
  if (!outcome.ok) {
    return outcome.error === 'cycle'
      ? { ok: false, kind: 'dependency-cycle', cycle: outcome.cycle, warnings: outcome.warnings }
      : { ok: false, kind: 'missing-master', missing: outcome.missing, warnings: outcome.warnings }
  }

  // Riprioritizza sulla sequenza calcolata. buildPluginsTxt ri-ordina per TYPE_RANK
  // (ESM → ESL → ESP) prima della priorità: dentro lo spazio master la sequenza può
  // quindi essere alterata tra ESM ed ESL — se ciò violerebbe un master REALE
  // (un .esm con master un .esl interno), va segnalato (l'engine però risolve i
  // master per nome, non per posizione: warning, non blocco).
  const seq = new Map<string, number>() // chiavi lowercase: NTFS e i MAST non sono case-sensitive
  outcome.order.forEach((name, i) => seq.set(name.toLowerCase(), i))
  const warnings = [...outcome.warnings]
  for (const p of planPlugins) {
    if (!p.name.toLowerCase().endsWith('.esm')) continue
    const masters = headerOf.get(p.name)?.masters ?? []
    for (const m of masters) {
      if (m.toLowerCase().endsWith('.esl') && seq.has(m.toLowerCase()))
        warnings.push(`"${p.name}" (.esm) ha come master "${m}" (.esl): plugins.txt li elenca ESM-prima per convenzione`)
    }
  }
  return {
    ok: true,
    plugins: planPlugins.map((p) => ({ ...p, priority: seq.get(p.name.toLowerCase()) ?? p.priority })),
    warnings,
  }
}
