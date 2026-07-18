// PURE deploy planner — no fs, no db. Given the enabled mods (each with its
// Data-relative file list, in priority order) it computes the deterministic
// override map, the junction/hardlink split, and the plugin load order. Testable
// in isolation exactly like planStockGame / planRecipe.
//
// Override rule (MO2/Nolvus): mods are applied in ascending priority; a file from
// a HIGHER-priority mod overrides the same destination path from a lower one — the
// last writer into the map wins. The final map is then split:
//   • a directory whose ENTIRE subtree in the final map is provided by a single mod
//     becomes ONE junction (avoids 100k individual hardlinks for a texture pack),
//   • every other file is an individual hardlink,
//   • root-level plugins (.esp/.esm/.esl) drive plugins.txt.

import { createHash } from 'crypto'

// Asset class used by the automatic conflict resolver (Nolvus-style, but the
// system decides for the user). A 'patch' always overrides plain assets; the
// other classes only matter for tie-breaks and debug labelling.
export type DeployCategory = 'patch' | 'gameplay' | 'texture' | 'mesh' | 'misc'

export interface DeployMod {
  name: string
  priority: number
  rootDir: string // absolute path of the deployed mod folder (Data-relative tree inside)
  files: string[] // Data-relative POSIX paths this mod provides
  category?: DeployCategory // asset class for auto-resolution (default 'misc')
  resolutionWeight?: number // e.g. 4K=4000, 2K=2000; higher wins a same-class tie (default 0)
}

export interface JunctionLink {
  dir: string // Data-relative directory to junction
  src: string // absolute source (rootDir/dir)
  mod: string // providing mod name
}

export interface HardLink {
  rel: string // Data-relative destination
  src: string // absolute source file
  mod: string
}

export type PluginType = 'ESM' | 'ESL' | 'ESP'

export interface PluginEntry {
  name: string
  type: PluginType
  mod: string
  priority: number
  /** Path sorgente assoluto del file plugin (per il parse dell'header TES4). */
  src?: string
}

// One auto-resolved file collision: two+ mods wrote the same destination, the
// resolver picked `winner` by the category/weight/priority rules and dropped
// `loser`. Purely informational — the deploy proceeds without asking the user.
export interface ResolvedConflict {
  file: string // canonical Data-relative path both mods provided
  winner: string // providing mod that owns the final file
  loser: string // overridden mod for this file
}

export interface DeployPlan {
  junctions: JunctionLink[]
  hardlinks: HardLink[]
  plugins: PluginEntry[]
  resolvedConflicts: ResolvedConflict[] // debug log of auto-resolved overrides
}

// Higher rank wins the category rule. A 'patch' beats every plain asset; the
// rest are ordered so mixed-class collisions still resolve deterministically.
const CATEGORY_RANK: Record<DeployCategory, number> = {
  patch: 4,
  gameplay: 3,
  mesh: 2,
  texture: 1,
  misc: 0,
}

// Valid deploy categories, DERIVED from CATEGORY_RANK so the set can never drift
// from the ranked union: adding a category to the rank automatically admits it here.
const DEPLOY_CATEGORIES = new Set(Object.keys(CATEGORY_RANK))

/** Narrow an untrusted DB string to a DeployCategory, else undefined (→ 'misc'). */
export function toDeployCategory(v: unknown): DeployCategory | undefined {
  return typeof v === 'string' && DEPLOY_CATEGORIES.has(v) ? (v as DeployCategory) : undefined
}

// Automatic winner between two mods that write the SAME destination file:
//   Rule 1 (category): higher CATEGORY_RANK wins — a patch always beats a texture.
//   Rule 2 (weight):   same class → higher resolutionWeight wins (4K over 2K).
//   Rule 3 (priority): same weight → higher priority_order wins (standard MO2).
//   Final tie-break by name so the plan is stable regardless of input order.
export function conflictWinner(a: DeployMod, b: DeployMod): DeployMod {
  const ra = CATEGORY_RANK[a.category ?? 'misc']
  const rb = CATEGORY_RANK[b.category ?? 'misc']
  if (ra !== rb) return ra > rb ? a : b
  const wa = a.resolutionWeight ?? 0
  const wb = b.resolutionWeight ?? 0
  if (wa !== wb) return wa > wb ? a : b
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b
  return a.name.localeCompare(b.name) >= 0 ? a : b
}

function normRel(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function parentDir(d: string): string {
  const i = d.lastIndexOf('/')
  return i === -1 ? '' : d.slice(0, i)
}

function pluginType(name: string): PluginType | null {
  const m = name.toLowerCase().match(/\.(esm|esl|esp)$/)
  if (!m) return null
  return m[1] === 'esm' ? 'ESM' : m[1] === 'esl' ? 'ESL' : 'ESP'
}

// Directory canoniche di una Data di Skyrim. Servono a riconoscere una root VALIDA dal
// CONTENUTO (come fanno MO2/Vortex) invece che dal nome della cartella.
const DATA_DIRS = new Set([
  'meshes',
  'textures',
  'scripts',
  'interface',
  'sound',
  'music',
  'seq',
  'shadersfx',
  'strings',
  'video',
  'lodsettings',
  'grass',
  'dialogueviews',
  'calientetools',
  'skse',
  'netscriptframework',
  'source',
  'facegen',
  'distantlod',
  'asi',
  'dllplugins',
  'nemesis_engine',
  'pandora_engine',
  'tools',
  'dyndolod',
  'skyproc patchers',
  'lightplacer',
  'seasons',
  'planetdata',
  'bookcovers',
])
const DATA_ROOT_EXT = /\.(esp|esm|esl|bsa|ba2|modgroups)$/i

// Rumore di root che i wrapper reali si portano dietro: non decide la forma dell'albero.
const ROOT_NOISE_RE = /\.(txt|md|jpg|jpeg|png|webp|pdf|html|ini|7z|zip|rar)$|^(fomod|meta\.ini|readme)/i

/**
 * true se `rels` (path relativi a una root candidata) sono già una Data valida: almeno un
 * plugin/BSA alla radice, OPPURE una directory canonica di Data al primo livello.
 * PURA: usata per decidere se strippare un wrapper, e per rifiutare strip che
 * peggiorerebbero l'albero.
 */
export function looksLikeDataRoot(rels: string[]): boolean {
  for (const r of rels) {
    const i = r.indexOf('/')
    if (i === -1) {
      if (DATA_ROOT_EXT.test(r)) return true
    } else if (DATA_DIRS.has(r.slice(0, i).toLowerCase())) return true
  }
  return false
}

/**
 * Toglie i wrapper di root con nome ARBITRARIO (`Beyond Skyrim Bruma/BSHeartland.esm`,
 * `Data/MCMHelper.esp`, e annidati come `Mod/Data/`).
 *
 * Prima si riconosceva il wrapper per NOME LETTERALE ('data'): un archivio incapsulato in
 * una cartella col nome della mod sopravviveva fino al piano, i suoi plugin non erano più
 * alla radice Data e sparivano dal load order — venendo poi riportati come "master mancanti"
 * benché i file fossero sul disco. Su questa modlist erano 489 mod su 1940.
 *
 * FAIL-SAFE: si strippa SOLO se il risultato è una Data riconoscibile. Se lo strip non
 * migliora l'albero si lascia tutto com'è (= comportamento storico, nessuna regressione).
 */
export function stripWrapperDirs(rels: string[], maxDepth = 3): { files: string[]; segments: string[] } {
  let files = rels
  const segments: string[] = []
  for (let depth = 0; depth < maxDepth; depth++) {
    if (looksLikeDataRoot(files)) break // già una Data valida: non toccare
    // Candidati alla decisione: i file "veri" (readme/fomod/immagini non contano).
    const decisive = files.filter((r) => !ROOT_NOISE_RE.test(r))
    if (!decisive.length) break
    const first = decisive[0].indexOf('/')
    if (first <= 0) break // c'è un file deciso alla radice → nessun wrapper uniforme
    const seg = decisive[0].slice(0, first)
    const segLower = seg.toLowerCase()
    // Uniformità: ogni file deciso deve stare sotto lo STESSO primo segmento.
    const uniform = decisive.every((r) => {
      const i = r.indexOf('/')
      return i > 0 && r.slice(0, i).toLowerCase() === segLower
    })
    if (!uniform) break
    files = files
      .filter((r) => r.toLowerCase().startsWith(`${segLower}/`))
      .map((r) => r.slice(seg.length + 1))
      .filter(Boolean)
    segments.push(seg)
  }
  // GUARDIA FAIL-SAFE sullo stato FINALE, non sui passi intermedi: un wrapper annidato
  // (`Mod/Data/…`) attraversa uno stato intermedio non-Data prima di arrivare a destinazione,
  // quindi validare ogni passo bloccherebbe proprio i casi che vogliamo risolvere. Se alla
  // fine l'albero non è riconoscibile come Data, si annulla TUTTO e si lascia l'originale
  // (= comportamento storico: meglio non deployare che deployare file a caso).
  if (segments.length && !looksLikeDataRoot(files)) return { files: rels, segments: [] }
  return { files, segments }
}

/** Regola utente: per `relPath` (Data-relative, confronto case-insensitive), se `winnerMod`
 *  è tra le mod che scrivono quel file, vince SEMPRE — bypassa categoria/peso/priorità solo
 *  per QUEL percorso (le altre destinazioni contese tra le stesse mod restano automatiche). */
export interface FileConflictRule {
  relPath: string
  winnerMod: string
}

// Directory (Data-relative, minuscole) che DEVONO restare cartelle REALI con file hardlinkati,
// MAI promosse a junction — nemmeno quando sono a proprietario unico. Alcuni plugin SKSE
// enumerano da soli questi alberi con una ricorsione che NON attraversa i reparse point
// (junction/symlink): trovano ciò che sta nella cartella scandita ma NON discendono nelle
// sottocartelle junctionate. Un hardlink è una normale voce di directory, trasparente a
// QUALSIASI scanner. Aggiungere qui un albero solo con prova che un plugin lo scandisce da sé
// e ha sottocartelle che il deploy junctiona (provider unico per sottocartella).
//   • skse/plugins/ostim/scenes — OStim (recursive_directory_iterator senza follow_directory_symlink):
//     con le sottocartelle scena junctionate legge 0 scene → in gioco "scene integrity could not be
//     verified" (log: "scene count mismatch: expected N, encountered 0").
//   • skse/lexicon — runtime di scripting Lexicon (LEX) e i suoi client (es. ActorValueGenerator):
//     scandisce SKSE/Lexicon/scripts per i .lsi; le sottocartelle per-mod (Shared, ActorValueGenerator)
//     vengono junctionate e gli script dentro non verrebbero caricati.
export const FORCE_HARDLINK_DIR_PREFIXES: readonly string[] = ['skse/plugins/ostim/scenes', 'skse/lexicon']

export function computeDeployPlan(
  mods: DeployMod[],
  fileRules: FileConflictRule[] = [],
  forceHardlinkPrefixes: readonly string[] = FORCE_HARDLINK_DIR_PREFIXES,
): DeployPlan {
  // Prefissi normalizzati: una directory che è (o sta sotto, o è antenata di) un prefisso forzato
  // non diventa junction — i suoi file ricadono sugli hardlink individuali del loop finale.
  const forced = forceHardlinkPrefixes.map((p) => normRel(p).toLowerCase()).filter(Boolean)
  const touchesForced = (dirLc: string) =>
    forced.some((p) => dirLc === p || dirLc.startsWith(`${p}/`) || p.startsWith(`${dirLc}/`))
  const pinnedWinnerByPath = new Map<string, string>()
  for (const r of fileRules) pinnedWinnerByPath.set(normRel(r.relPath).toLowerCase(), r.winnerMod.toLowerCase())
  // Deterministic base order (ascending priority, name tie-break) so candidate
  // lists — and therefore the resolved-conflict log — are stable across input order.
  const ordered = [...mods].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))

  // Archive messiness reale: molte mod arrivano col loro albero INCAPSULATO in una cartella
  // Data/ di primo livello (es. `Data/MCM/...`, `Data/MCMHelper.esp`). Il deploy vuole percorsi
  // Data-RELATIVE: quando l'INTERO albero di una mod sta sotto Data/, il prefisso viene tolto e
  // la root efficace diventa `<rootDir>/Data` — esattamente ciò che fanno MO2/Vortex all'install.
  // Senza questo si otteneva `Data/Data/...` nell'istanza e i plugin della mod (annidati sotto
  // Data/) non finivano mai nel load order.
  const normalized = ordered.map((mod) => {
    const rels = mod.files.map(normRel).filter(Boolean)
    if (!rels.length) return { mod, files: rels, root: mod.rootDir }
    const { files, segments } = stripWrapperDirs(rels)
    if (!segments.length) return { mod, files: rels, root: mod.rootDir }
    // La root efficace scende dentro i wrapper tolti, mantenendone il casing originale.
    return { mod, files, root: `${mod.rootDir}/${segments.join('/')}` }
  })

  // Every mod that writes each destination key (lowercased destRel → candidates).
  // Canonical (original-case) path is carried per candidate so emitted paths keep
  // the WINNER's source casing.
  interface Candidate {
    mod: DeployMod
    rel: string
    src: string
  }
  const candidates = new Map<string, Candidate[]>()
  for (const entry of normalized) {
    for (const rel of entry.files) {
      const key = rel.toLowerCase()
      let arr = candidates.get(key)
      if (!arr) candidates.set(key, (arr = []))
      // A mod listing the same file twice contributes a single candidate.
      if (!arr.some((c) => c.mod === entry.mod)) arr.push({ mod: entry.mod, rel, src: `${entry.root}/${rel}` })
    }
  }
  // Root efficace per mod (per le junction: la sorgente deve includere l'eventuale Data/ tolta).
  const rootOf = new Map<DeployMod, string>(normalized.map((e) => [e.mod, e.root]))

  // Resolve each destination to ONE winner via the category/weight/priority rules,
  // recording every override we auto-resolved so the user can audit the choices.
  const provider = new Map<string, DeployMod>()
  const srcOf = new Map<string, string>()
  const canon = new Map<string, string>()
  const resolvedConflicts: ResolvedConflict[] = []
  for (const [key, arr] of candidates) {
    // Una regola utente PINNA il vincitore per questo esatto percorso, se la mod scelta è
    // davvero tra i candidati (altrimenti la regola è orfana — mod rimossa/rinominata — e si
    // ricade sulla risoluzione automatica, mai un errore silenzioso su una mod inesistente).
    const pinnedName = pinnedWinnerByPath.get(key)
    const pinned = pinnedName ? arr.find((c) => c.mod.name.toLowerCase() === pinnedName) : undefined
    let win = pinned ?? arr[0]
    if (!pinned) {
      for (let i = 1; i < arr.length; i++) {
        if (conflictWinner(win.mod, arr[i].mod) !== win.mod) win = arr[i]
      }
    }
    provider.set(key, win.mod)
    srcOf.set(key, win.src)
    canon.set(key, win.rel)
    if (arr.length > 1) {
      for (const c of arr) {
        if (c.mod !== win.mod)
          resolvedConflicts.push({ file: win.rel, winner: win.mod.name, loser: c.mod.name })
      }
    }
  }

  // Provider set for every ancestor directory of every final file. A directory
  // owned by exactly one mod is a junction candidate. Keys are LOWERCASED: NTFS è
  // case-insensitive, quindi `MCM/` e `mcm/` sono la STESSA directory di destinazione —
  // con chiavi case-sensitive due mod con casing diverso producevano due junction in
  // collisione (EEXIST) invece di un normale conflitto risolto per file.
  const dirProviders = new Map<string, Set<DeployMod>>()
  const dirCanon = new Map<string, string>() // dirLc → casing canonico (primo provider visto)
  for (const key of provider.keys()) {
    const rel = canon.get(key)!
    const mod = provider.get(key)!
    const segs = rel.split('/')
    for (let i = 0; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/') // '' = root, then each ancestor dir
      const dirLc = dir.toLowerCase()
      let set = dirProviders.get(dirLc)
      if (!set) dirProviders.set(dirLc, (set = new Set()))
      set.add(mod)
      if (dir && !dirCanon.has(dirLc)) dirCanon.set(dirLc, dir)
    }
  }

  // Pick MAXIMAL single-provider directories: providers(D)==1 and either D is a
  // top-level dir (parent is root) or the parent is mixed (so D is the largest
  // conflict-free subtree). Shallowest-first so nested dirs are skipped once an
  // ancestor is junctioned.
  const junctions: JunctionLink[] = []
  const junctionDirsLc: string[] = []
  const underJunction = (pathLc: string) =>
    junctionDirsLc.some((j) => pathLc === j || pathLc.startsWith(j + '/'))
  const dirsByDepth = [...dirProviders.keys()]
    .filter((d) => d !== '')
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  for (const dirLc of dirsByDepth) {
    if (underJunction(dirLc)) continue
    // Albero che un plugin SKSE scandisce da solo senza seguire i reparse point: resta cartella
    // reale, i suoi file diventano hardlink nel loop finale (vedi FORCE_HARDLINK_DIR_PREFIXES).
    if (touchesForced(dirLc)) continue
    const set = dirProviders.get(dirLc)!
    if (set.size !== 1) continue
    const parent = parentDir(dirLc)
    const parentMixed = parent === '' || (dirProviders.get(parent)?.size ?? 0) > 1
    if (!parentMixed) continue
    const mod = [...set][0]
    const dir = dirCanon.get(dirLc) ?? dirLc
    // Sorgente dalla ROOT EFFICACE della mod (include l'eventuale wrapper Data/ tolto).
    junctions.push({ dir, src: `${rootOf.get(mod) ?? mod.rootDir}/${dir}`, mod: mod.name })
    junctionDirsLc.push(dirLc)
  }

  // Everything not covered by a junction is an individual hardlink.
  const hardlinks: HardLink[] = []
  const plugins: PluginEntry[] = []
  for (const key of provider.keys()) {
    const rel = canon.get(key)!
    const mod = provider.get(key)!
    const dir = parentDir(rel)
    if (!underJunction((dir === '' ? rel : dir).toLowerCase())) {
      hardlinks.push({ rel, src: srcOf.get(key)!, mod: mod.name })
    }
    // Plugins live at the Data root (no directory component).
    if (dir === '') {
      const t = pluginType(rel)
      if (t) plugins.push({ name: rel, type: t, mod: mod.name, priority: mod.priority, src: srcOf.get(key)! })
    }
  }

  // Stable ordering for deterministic output.
  hardlinks.sort((a, b) => a.rel.localeCompare(b.rel))
  junctions.sort((a, b) => a.dir.localeCompare(b.dir))
  resolvedConflicts.sort((a, b) => a.file.localeCompare(b.file) || a.loser.localeCompare(b.loser))
  return { junctions, hardlinks, plugins, resolvedConflicts }
}

const TYPE_RANK: Record<PluginType, number> = { ESM: 0, ESL: 1, ESP: 2 }

// ── Ordinamento plugin sul grafo delle dipendenze (load order sicuro) ─────────────────────────
// La priorità utente da sola non basta: se la mod A richiede la master della mod B ma l'utente ha
// dato ad A priorità più bassa, il gioco crasha al load ("missing master"). Qui i MOD che
// forniscono plugin vengono riordinati topologicamente sul grafo `requires` del catalogo
// (dipendenze prima dei dipendenti), stabile rispetto a (priorità, nome) tra i nodi pronti.
// Un ciclo nel grafo è un dato corrotto: NIENTE ordine parziale silenzioso — il chiamante deve
// BLOCCARE il deploy e riportare il ciclo all'utente (fail-safe, mai un plugins.txt azzardato).

export type PluginOrderResult =
  | { ok: true; plugins: PluginEntry[] }
  | { ok: false; cycle: string[] } // nomi dei mod coinvolti nel ciclo, in ordine di attraversamento

export function orderPluginsByDependencies(
  plugins: PluginEntry[],
  nexusIdOf: Map<string, number>, // providing-mod name → nexus_id (mod senza id = nodo isolato)
  requires: Map<number, number[]>, // grafo requires del catalogo (nexus_id → deps)
): PluginOrderResult {
  if (!plugins.length) return { ok: true, plugins: [] }
  // Nodi = mod che forniscono plugin in QUESTO deploy. Priorità di un nodo = min tra i suoi plugin.
  const modPriority = new Map<string, number>()
  for (const p of plugins) {
    const cur = modPriority.get(p.mod)
    if (cur == null || p.priority < cur) modPriority.set(p.mod, p.priority)
  }
  const nodes = [...modPriority.keys()]
  const byNexus = new Map<number, string>()
  for (const n of nodes) {
    const id = nexusIdOf.get(n)
    if (id != null) byNexus.set(id, n)
  }
  // Archi dep→dependent, SOLO tra mod entrambi presenti nel deploy (una dipendenza esterna non
  // vincola l'ordine interno). indegree[dependent] = numero di dipendenze interne.
  const dependents = new Map<string, string[]>()
  const indegree = new Map<string, number>(nodes.map((n) => [n, 0]))
  for (const n of nodes) {
    const id = nexusIdOf.get(n)
    if (id == null) continue
    for (const depId of requires.get(id) ?? []) {
      const depMod = byNexus.get(depId)
      if (!depMod || depMod === n) continue
      const arr = dependents.get(depMod) ?? []
      arr.push(n)
      dependents.set(depMod, arr)
      indegree.set(n, (indegree.get(n) ?? 0) + 1)
    }
  }
  // Kahn stabile: tra i nodi pronti vince (priorità utente, nome) — l'ordine utente resta il
  // tie-break dentro i vincoli del grafo.
  const readySort = (a: string, b: string) =>
    (modPriority.get(a) ?? 0) - (modPriority.get(b) ?? 0) || a.localeCompare(b)
  const ready = nodes.filter((n) => (indegree.get(n) ?? 0) === 0).sort(readySort)
  const seq = new Map<string, number>()
  while (ready.length) {
    const n = ready.shift() as string
    seq.set(n, seq.size)
    for (const d of dependents.get(n) ?? []) {
      const left = (indegree.get(d) ?? 1) - 1
      indegree.set(d, left)
      if (left === 0) {
        ready.push(d)
        ready.sort(readySort)
      }
    }
  }
  if (seq.size !== nodes.length) {
    // Ciclo: estrai un percorso concreto tra i nodi rimasti per un messaggio actionable.
    const remaining = new Set(nodes.filter((n) => !seq.has(n)))
    const start = [...remaining].sort(readySort)[0]
    const cycle: string[] = []
    const visited = new Set<string>()
    let cur: string | undefined = start
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      cycle.push(cur)
      const id: number | undefined = nexusIdOf.get(cur)
      cur = id == null ? undefined : (requires.get(id) ?? []).map((d) => byNexus.get(d)).find((m) => m && remaining.has(m))
    }
    if (cur) cycle.push(cur) // chiude visivamente il ciclo (A → B → A)
    return { ok: false, cycle }
  }
  // Riscrivi la priorità dei plugin con la sequenza topologica del loro mod: buildPluginsTxt
  // (type-rank → priority) produrrà così un ordine che rispetta il grafo dentro ogni gruppo.
  return {
    ok: true,
    plugins: plugins.map((p) => ({ ...p, priority: seq.get(p.mod) ?? p.priority })),
  }
}

// ── Manifest di deploy (purge esatto) ─────────────────────────────────────────────────────────
// Registra ESATTAMENTE ciò che il deployer ha creato nell'istanza. Il purge manifest-based rimuove
// solo queste voci: è l'unico purge sicuro quando il target contiene file vanilla GIÀ hardlinkati
// (StockGame: i BSA puntano agli originali Steam, nlink>1 — l'euristica lì cancellerebbe la base).
export const DEPLOY_MANIFEST_FILE = '.smm-deploy-manifest.json'

export interface DeployManifest {
  version: 1
  target: string // instance Data dir del deploy
  junctions: string[] // dir Data-relative junctionate
  files: string[] // file Data-relative hardlinkati (mod + Creation Club)
  /** File PREESISTENTI nel target sostituiti da una mod: l'originale è stato rinominato in
   *  `<rel>.smm-vanilla.bak` e il purge lo ripristina. Serve quando il target è la Data del
   *  GIOCO REALE (file vanilla/CC/SKSE loose), mai su un'istanza vuota. */
  backups?: string[]
  pluginsTxt?: string // percorso assoluto del plugins.txt d'istanza scritto
  systemPluginsTxt?: string // percorso assoluto del plugins.txt di sistema (%LOCALAPPDATA%) scritto
  /** Fingerprint (vedi computeModsFingerprint) delle mod abilitate AL MOMENTO di questo deploy.
   *  Confrontata al prossimo lancio con lo stato corrente del profilo: se differisce, l'utente
   *  ha cambiato selezione/priorità mod senza rifare il deploy (gioco avviato su stato stantio). */
  modsFingerprint?: string
  /** File Data-relative deployati per COPIA invece che hardlink (fallback cross-volume: la mod
   *  sorgente vive su un volume diverso dall'istanza, dove linkSync fallisce con EXDEV). nlink===1
   *  è NORMALE per questi file — verifyDeployedInstance li esclude dal check "sostituito
   *  esternamente" che userebbe altrimenti nlink===1 come segnale di manomissione. */
  copied?: string[]
}

/** Fingerprint stabile e deterministico dello stato "mod abilitate" di un profilo (nome+priorità,
 *  ordinate per nome). Usata per rilevare un deploy pendente: se il fingerprint calcolato ORA sullo
 *  stato del DB differisce da quello salvato nel manifest all'ultimo deploy, la Data del gioco non
 *  riflette più la selezione corrente. Import locale a 'crypto' (Node) — resta una funzione pura,
 *  nessun I/O: stesso input → stesso output, nessun side effect.
 */
export function computeModsFingerprint(mods: { name: string; priority: number }[]): string {
  const sorted = [...mods].sort((a, b) => a.name.localeCompare(b.name))
  const raw = sorted.map((m) => `${m.name.toLowerCase()}:${m.priority}`).join('|')
  return createHash('sha256').update(raw).digest('hex')
}

/** Suffisso dei backup degli originali sostituiti (vedi DeployManifest.backups). */
export const VANILLA_BACKUP_SUFFIX = '.smm-vanilla.bak'

/**
 * Parse difensivo del manifest letto da disco: qualsiasi forma inattesa → null (mai throw).
 * JSON illeggibile (troncato/corrotto) è sempre irrecuperabile → null: non c'è dato da riparare.
 * Se il JSON è valido ma `target` manca (es. manifest storico o modificato a mano) e il chiamante
 * conosce già il percorso reale (`fallbackTarget`, il dir che ha appena letto il file), lo si usa
 * per riparare invece di scartare l'intero manifest — evita che purge/verify tornino "nessun
 * manifest" (che sul target gioco reale con allowHeuristicCleanup=false blocca il purge) per un
 * singolo campo mancante quando junctions/files sono ancora leggibili.
 */
export function parseDeployManifest(raw: string, fallbackTarget?: string): DeployManifest | null {
  try {
    const m = JSON.parse(raw) as Partial<DeployManifest>
    if (typeof m !== 'object' || m === null) return null
    if (m.version !== undefined && m.version !== 1) return null // formato futuro sconosciuto: non riparabile
    const target = typeof m.target === 'string' ? m.target : fallbackTarget
    if (!target) return null
    return {
      version: 1,
      target,
      junctions: Array.isArray(m.junctions) ? m.junctions.filter((x): x is string => typeof x === 'string') : [],
      files: Array.isArray(m.files) ? m.files.filter((x): x is string => typeof x === 'string') : [],
      backups: Array.isArray(m.backups)
        ? m.backups.filter((x): x is string => typeof x === 'string')
        : undefined,
      pluginsTxt: typeof m.pluginsTxt === 'string' ? m.pluginsTxt : undefined,
      systemPluginsTxt: typeof m.systemPluginsTxt === 'string' ? m.systemPluginsTxt : undefined,
      modsFingerprint: typeof m.modsFingerprint === 'string' ? m.modsFingerprint : undefined,
      copied: Array.isArray(m.copied) ? m.copied.filter((x): x is string => typeof x === 'string') : undefined,
    }
  } catch {
    return null
  }
}

// Base-game masters always load first (they live in the read-only StockGame Data,
// not in any mod folder, so they are prepended here for a complete load order).
export const BASE_MASTERS = [
  'Skyrim.esm',
  'Update.esm',
  'Dawnguard.esm',
  'HearthFires.esm',
  'Dragonborn.esm',
]

/**
 * Deterministic plugins.txt: base masters first (unprefixed, implicitly active), then
 * the Creation Club "System DLC" block (forced right after the official DLCs, in
 * Bethesda load order), then mod plugins (ESM → ESL → ESP, by providing-mod priority).
 * CC and mod plugins are prefixed with '*' (active). A mod plugin whose name matches a
 * base master or a CC plugin is de-duplicated (the CC/master slot wins its position).
 */
export function buildPluginsTxt(plugins: PluginEntry[], ccPlugins: string[] = []): string {
  const seen = new Set(BASE_MASTERS.map((m) => m.toLowerCase()))
  // CC block: system DLC, forced immediately after the base masters in the given order.
  const cc: string[] = []
  for (const name of ccPlugins) {
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    cc.push(name)
  }
  const ordered = [...plugins]
    .filter((p) => {
      const k = p.name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort(
      (a, b) =>
        TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
        a.priority - b.priority ||
        a.mod.localeCompare(b.mod) ||
        a.name.localeCompare(b.name),
    )
  const lines = [
    '# Generated by Skyrim Mod Manager — do not edit by hand',
    ...BASE_MASTERS,
    ...cc.map((n) => `*${n}`),
    ...ordered.map((p) => `*${p.name}`),
  ]
  return lines.join('\n') + '\n'
}
