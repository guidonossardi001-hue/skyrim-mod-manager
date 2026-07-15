// Sorter LOOT-like del load order — PURO, unit-testabile senza fs.
//
// Fonte di verità: i master REALI dichiarati nell'header TES4 di ogni plugin
// (espParser). Il campo `requires` del catalogo entra come fallback HARD per i soli
// plugin con header illeggibile (unica verità disponibile: un suo ciclo resta dato
// corrotto da bloccare). Le regole `after` opzionali (masterlist-lite) sono SOFT: se
// creano un ciclo vengono scartate con warning, mai un blocco (comportamento LOOT:
// una regola utente non deve brickare il sort).
//
// Fail-safe HARD (bloccano il deploy, mai un plugins.txt azzardato):
//   • missing-master: un plugin richiede un master né deployato né esterno (vanilla/CC)
//     → il gioco crasherebbe al load. Report completo, non first-fail.
//   • cycle: ciclo tra master REALI (dati corrotti) → nessun ordine parziale silenzioso.

export interface LootPlugin {
  name: string // nome file del plugin (es. "Quest.esp")
  priority: number // tie-break utente (priorità della mod che lo fornisce)
  /** true = spazio master (flag ESM o estensione .esm/.esl) — vedi isMasterSpace. */
  masterSpace: boolean
  /** Master reali dall'header TES4; null = header illeggibile → si usa fallbackAfter. */
  masters: string[] | null
  /** Edges soft dal grafo catalogo (nomi plugin), usati SOLO quando masters == null. */
  fallbackAfter?: string[]
  /** Posizione del gruppo LOOT reale (rank topologico, 0 = primo). Assente = nessun dato:
   *  tutti i plugin senza rank sono a pari merito e il tie-break ricade su (priority, nome)
   *  esattamente come prima di questo campo — additivo, non cambia il comportamento esistente. */
  groupRank?: number
}

/** Regola masterlist-lite: `plugin` va caricato dopo OGNUNO di `after` (edges soft). */
export interface LootRule {
  plugin: string
  after: string[]
}

export type LootSortOutcome =
  | { ok: true; order: string[]; warnings: string[] }
  | {
      ok: false
      error: 'missing-master'
      missing: { plugin: string; masters: string[] }[]
      warnings: string[]
    }
  | { ok: false; error: 'cycle'; cycle: string[]; warnings: string[] }

interface Edge {
  from: string // lowercase name del prerequisito (caricato prima)
  to: string // lowercase name del dipendente
  soft: boolean // true = fallback catalogo o regola (scartabile su ciclo)
}

/**
 * Ordina i plugin: partizione spazio-master → regular (regola engine), topologico di
 * Kahn dentro ogni partizione, stabile su (priority, nome) tra i nodi pronti.
 * `externalMasters` = plugin presenti FUORI dal deploy (vanilla + Creation Club):
 * soddisfano un requisito master senza creare edges (caricano comunque prima).
 */
export function lootSort(
  plugins: LootPlugin[],
  opts: { externalMasters?: string[]; rules?: LootRule[] } = {},
): LootSortOutcome {
  const warnings: string[] = []
  if (!plugins.length) return { ok: true, order: [], warnings }

  const byLower = new Map<string, LootPlugin>()
  for (const p of plugins) byLower.set(p.name.toLowerCase(), p)
  const external = new Set((opts.externalMasters ?? []).map((n) => n.toLowerCase()))

  // ── Missing masters: check completo PRIMA di qualsiasi sort ─────────────────────
  const missing: { plugin: string; masters: string[] }[] = []
  for (const p of plugins) {
    if (!p.masters) continue // header illeggibile: nessuna pretesa, solo fallback soft
    const lost = p.masters.filter((m) => !byLower.has(m.toLowerCase()) && !external.has(m.toLowerCase()))
    if (lost.length) missing.push({ plugin: p.name, masters: lost })
  }
  if (missing.length) return { ok: false, error: 'missing-master', missing, warnings }

  // ── Edges ───────────────────────────────────────────────────────────────────────
  const edges: Edge[] = []
  const addEdge = (fromName: string, toPlugin: LootPlugin, soft: boolean, label: string) => {
    const from = fromName.toLowerCase()
    const to = toPlugin.name.toLowerCase()
    if (from === to) return
    const dep = byLower.get(from)
    if (!dep) return // esterno o inesistente: nessun vincolo interno
    // Cross-partition impossibile per l'engine: un plugin dello spazio master non può
    // caricare DOPO un regular. Edge ignorato con warning (LOOT lo segnala, non blocca).
    if (toPlugin.masterSpace && !dep.masterSpace) {
      warnings.push(
        `"${toPlugin.name}" (spazio master) dichiara ${label} verso il non-master "${dep.name}": vincolo non applicabile, ignorato`,
      )
      return
    }
    edges.push({ from, to, soft })
  }
  for (const p of plugins) {
    // Master reali E fallback catalogo sono entrambi HARD: il fallback è l'unica verità
    // disponibile quando l'header è illeggibile, e un suo ciclo resta dato corrotto da
    // bloccare (semantica invariata rispetto all'ordinamento solo-catalogo precedente).
    if (p.masters) for (const m of p.masters) addEdge(m, p, false, 'un master')
    else for (const f of p.fallbackAfter ?? []) addEdge(f, p, false, 'una dipendenza di catalogo')
  }
  for (const r of opts.rules ?? []) {
    const target = byLower.get(r.plugin.toLowerCase())
    if (!target) continue
    for (const a of r.after) addEdge(a, target, true, 'una regola "after"')
  }

  // groupRank assente = pari merito (Infinity): il confronto ricade su (priority, nome)
  // esattamente come prima dell'introduzione del rank di gruppo LOOT.
  const rankOf = (p: LootPlugin) => p.groupRank ?? Number.POSITIVE_INFINITY
  const compare = (a: LootPlugin, b: LootPlugin) =>
    rankOf(a) - rankOf(b) || a.priority - b.priority || a.name.localeCompare(b.name)

  // ── Kahn per partizione, stabile su (groupRank, priority, nome) ─────────────────
  const runKahn = (useSoft: boolean): { order: string[] } | { cycle: string[] } => {
    const active = edges.filter((e) => !e.soft || useSoft)
    const indegree = new Map<string, number>()
    const out = new Map<string, string[]>()
    for (const p of plugins) indegree.set(p.name.toLowerCase(), 0)
    for (const e of active) {
      indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
      const list = out.get(e.from) ?? []
      list.push(e.to)
      out.set(e.from, list)
    }
    const order: string[] = []
    // Due passate: prima l'intero spazio master, poi i regular. Un edge master→regular
    // resta valido (il master è già uscito); un edge regular→master è già stato scartato.
    for (const wantMaster of [true, false]) {
      const ready = plugins
        .filter((p) => p.masterSpace === wantMaster && (indegree.get(p.name.toLowerCase()) ?? 0) === 0)
        .sort(compare)
      while (ready.length) {
        const cur = ready.shift()!
        order.push(cur.name)
        for (const dep of out.get(cur.name.toLowerCase()) ?? []) {
          const left = (indegree.get(dep) ?? 0) - 1
          indegree.set(dep, left)
          if (left === 0) {
            const p = byLower.get(dep)!
            if (p.masterSpace !== wantMaster) continue // uscirà nella sua passata
            // Inserimento ordinato: mantiene il ready-set stabile su (groupRank, priority, nome).
            const at = ready.findIndex((q) => compare(q, p) > 0)
            ready.splice(at === -1 ? ready.length : at, 0, p)
          }
        }
      }
    }
    if (order.length === plugins.length) return { order }
    // Ciclo: cammino concreto tra i nodi residui (indegree > 0) via DFS.
    const stuck = new Set(plugins.map((p) => p.name.toLowerCase()).filter((n) => !order.some((o) => o.toLowerCase() === n)))
    return { cycle: findCycle(stuck, active, byLower) }
  }

  let res = runKahn(true)
  if ('cycle' in res && edges.some((e) => e.soft)) {
    // Solo le REGOLE (masterlist-lite) sono soft: una regola utente non deve mai brickare
    // il sort (comportamento LOOT). Riprova senza regole prima di dichiarare il ciclo.
    warnings.push('ciclo generato dalle regole "after": regole scartate, ordine sui soli vincoli reali')
    res = runKahn(false)
  }
  if ('cycle' in res) return { ok: false, error: 'cycle', cycle: res.cycle, warnings }
  return { ok: true, order: res.order, warnings }
}

/** Estrae un ciclo concreto (nomi originali) dal sottografo dei nodi non ordinabili. */
function findCycle(stuck: Set<string>, edges: Edge[], byLower: Map<string, LootPlugin>): string[] {
  const out = new Map<string, string[]>()
  for (const e of edges) {
    if (!stuck.has(e.from) || !stuck.has(e.to)) continue
    const list = out.get(e.from) ?? []
    list.push(e.to)
    out.set(e.from, list)
  }
  const state = new Map<string, 1 | 2>() // 1 = in stack, 2 = done
  const stack: string[] = []
  const dfs = (n: string): string[] | null => {
    state.set(n, 1)
    stack.push(n)
    for (const next of out.get(n) ?? []) {
      const s = state.get(next)
      if (s === 1) return stack.slice(stack.indexOf(next))
      if (s !== 2) {
        const found = dfs(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(n, 2)
    return null
  }
  for (const n of stuck) {
    if (!state.has(n)) {
      const found = dfs(n)
      if (found) return found.map((x) => byLower.get(x)?.name ?? x)
    }
  }
  return [...stuck].map((x) => byLower.get(x)?.name ?? x) // degenerato: nessun cammino chiuso trovato
}
