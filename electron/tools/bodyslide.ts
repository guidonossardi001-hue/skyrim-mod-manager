import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// BodySlide batch build (BODYSLIDE-01) — corpi, fisiche e outfit della collection.
//
// BodySlide arriva GIÀ come mod della collection (CalienteTools/BodySlide) e il
// deploy hardlinka nell'albero Data del gioco l'unione di TUTTI i progetti
// (SliderSets/ShapeData/SliderGroups/SliderPresets) sparsi nelle ~1900 mod.
// Questo modulo pianifica il batch build headless sull'exe DEPLOYATO:
//   BodySlide.exe --groupbuild "A,B,…" --preset "X" --targetdir "<output>" --trimorphs
// (flag verificati sul wiki ufficiale ousnius: --groupbuild costruisce ed esce;
//  --trimorphs genera i morph .tri per RaceMenu/OStim/OBody).
//
// Due invarianti di sicurezza, imposte dal CHIAMANTE con gli helper qui sotto:
//   1. MAI costruire dentro Data: i file deployati sono hardlink e una scrittura
//      in-place corromperebbe la copia sorgente della mod. L'output va in una
//      cartella-mod dedicata (--targetdir) che il deploy poi fa vincere.
//   2. Config.xml dell'exe deployato va RISCRITTO come file reale (rompendo
//      l'hardlink) prima dello spawn: BodySlide salva le impostazioni all'uscita
//      e scriverebbe dentro la mod sorgente.
//
// PURO: niente IO diretto — filesystem iniettato via BsFs, unit-testabile.
// ─────────────────────────────────────────────────────────────────────────────

export const BODYSLIDE_DIR_REL = join('CalienteTools', 'BodySlide')
export const BODYSLIDE_EXE = 'BodySlide.exe'
/** Nome riga mods + cartella output: la "mod generata" coi mesh costruiti. */
export const BODYSLIDE_OUTPUT_MOD_NAME = 'BodySlide Output (generato)'
export const BODYSLIDE_OUTPUT_DIR = 'bodyslide-output'
/** Peso conflitti: l'output DEVE vincere su ogni mesh/outfit deployato. */
export const BODYSLIDE_OUTPUT_WEIGHT = 1_000_000

export interface BsFs {
  exists(p: string): boolean
  readdir(p: string): string[] // no-throw: [] su errore
  readFile(p: string): string | null // no-throw: null su errore
}

export interface BodySlidePreset {
  name: string
  set: string
  /** Gruppi dichiarati dal preset (ambito di applicazione). */
  groups: string[]
  file: string
}

export interface BodySlideAssets {
  exePath: string | null
  presets: BodySlidePreset[]
  /** Nomi gruppo unici dichiarati in SliderGroups/*.xml (esclusi i nostri gruppi sintetici). */
  groups: string[]
  /** Progetti .osp in SliderSets (indicatore di copertura outfit). */
  setsCount: number
  /** Set-corpo (output femalebody/malebody) per l'enforcement nude/nevernude. */
  bodySets: BodySet[]
}

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** Estrae i preset (nome, set, gruppi) da un file SliderPresets XML. Difensivo: mai throw. */
export function parseSliderPresets(xml: string, file: string): BodySlidePreset[] {
  const out: BodySlidePreset[] = []
  for (const m of xml.matchAll(/<Preset\b([^>]*)>([\s\S]*?)<\/Preset>/gi)) {
    const name = /\bname="([^"]*)"/i.exec(m[1])?.[1]
    if (!name) continue
    const set = /\bset="([^"]*)"/i.exec(m[1])?.[1] ?? ''
    const groups: string[] = []
    for (const g of m[2].matchAll(/<Group\b[^>]*\bname="([^"]*)"/gi)) groups.push(decodeXml(g[1]))
    out.push({ name: decodeXml(name), set: decodeXml(set), groups, file })
  }
  return out
}

/** Estrae i nomi gruppo da un file SliderGroups XML (tag <Group name="…">). */
export function parseGroupNames(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<Group\b[^>]*\bname="([^"]*)"/gi)) out.push(decodeXml(m[1]))
  return out
}

// ── Body base: nude vs nevernude ─────────────────────────────────────────────
// Il corpo base femminile/maschile è un OUTFIT BodySlide (SliderSet) che scrive
// femalebody.nif/malebody.nif. Nude e "nevernude" (bra/mutande cotti nel mesh)
// scrivono lo STESSO file e stanno nello STESSO gruppo: un --groupbuild li costruisce
// entrambi e vince l'ultimo (ordine non controllabile) → nevernude clobbera il nude.
// Soluzione: un pass finale che ricostruisce per ULTIMO solo il corpo della nudità scelta.

export interface BodySet {
  name: string
  /** Basename dell'OutputFile in minuscolo (es. 'femalebody', 'malebody'). */
  output: string
  /** Nudità dedotta dal nome: nevernude/underwear = coperto. */
  nevernude: boolean
}

/** Prefisso dei gruppi sintetici creati da noi: esclusi dai pass principali. */
export const SMM_GROUP_PREFIX = 'SMM '
export const SMM_FEMALE_BODY_GROUP = 'SMM Base Body (femminile)'
export const SMM_MALE_BODY_GROUP = 'SMM Base Body (maschile)'
export const SMM_BODY_GROUPS_FILE = 'zz-smm-base-body.xml'

const NEVERNUDE_RE = /nevernude|never nude|underwear|\bbra\b|panties|\bcovered\b/i
const FEMALE_BODY_OUTPUT = 'femalebody'
const MALE_BODY_OUTPUT = 'malebody'

/** Estrae i SliderSet-corpo da un .osp: nome, OutputFile (basename) e flag nevernude. */
export function parseBodySets(osp: string): BodySet[] {
  const out: BodySet[] = []
  for (const m of osp.matchAll(/<SliderSet\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/SliderSet>/gi)) {
    const name = decodeXml(m[1])
    const file = /<OutputFile\b[^>]*>([^<]*)<\/OutputFile>/i.exec(m[2])?.[1]?.trim()
    if (!file) continue
    // OutputFile può contenere un path relativo: teniamo solo il basename, senza estensione.
    const base = file.replace(/\\/g, '/').split('/').pop()!.replace(/\.nif$/i, '').toLowerCase()
    out.push({ name, output: base, nevernude: NEVERNUDE_RE.test(name) })
  }
  return out
}

export interface EnforcePass {
  label: string
  /** Nome del gruppo SINTETICO da scrivere e passare a --groupbuild. */
  group: string
  /** Set del gruppo; il vincitore desiderato è messo per ULTIMO. */
  members: string[]
  preset: string
}

/**
 * Ordina i set-corpo di una nudità così che il vincitore del file sia costruito per ultimo:
 * il set del PRESET scelto (l'autore l'ha pensato per quel corpo) vince; a parità, i 3BA/3BBB
 * battono il CBBE liscio. `preferSet` = preset.set (case-insensitive).
 */
function orderBodyMembers(sets: BodySet[], preferSet?: string): string[] {
  const want = (preferSet ?? '').toLowerCase()
  const score = (s: BodySet): number => {
    if (want && s.name.toLowerCase() === want) return 3 // il set del preset: vincitore assoluto
    if (/\b3b(a|bb)\b|amazing/i.test(s.name)) return 2 // corpo 3BA/3BBB della collection
    return 1
  }
  // Ordine crescente di priorità: BodySlide costruisce in ordine, l'ultimo scrive il file.
  return [...sets].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name)).map((s) => s.name)
}

/**
 * Pass di enforcement per il corpo base della nudità scelta (default nude). Per ogni genere con
 * almeno un set-corpo della nudità voluta, un gruppo sintetico costruito PER ULTIMO nel batch:
 * garantisce femalebody/malebody nella variante scelta a prescindere dall'ordine dei gruppi.
 */
export function planBodyEnforcement(
  bodySets: BodySet[],
  opts: { nudity?: 'nude' | 'nevernude'; femalePreset?: BodySlidePreset; malePreset?: BodySlidePreset } = {},
): EnforcePass[] {
  const nudity = opts.nudity ?? 'nude'
  const wantNevernude = nudity === 'nevernude'
  const passes: EnforcePass[] = []

  const genderPasses = (
    output: string,
    label: string,
    group: string,
    preset: BodySlidePreset | undefined,
  ): void => {
    const sets = bodySets.filter((s) => s.output === output && s.nevernude === wantNevernude)
    if (!sets.length || !preset) return // mai un gruppo vuoto
    const ordered = orderBodyMembers(sets, preset.set)
    // Pass 1: TUTTI i corpi della nudità scelta (copre base + follower, ognuno col proprio path).
    passes.push({ label: `${label} (${nudity})`, group, members: ordered, preset: preset.name })
    // Pass 2: SOLO il corpo preferito, in un gruppo a sé costruito ancora dopo. L'ordine di build
    // DENTRO un --groupbuild non è garantito da BodySlide, quindi un pass a membro singolo è
    // l'unico modo deterministico per far vincere il corpo giusto (3BA) sullo slot principale.
    const preferred = ordered[ordered.length - 1]
    if (ordered.length > 1) {
      passes.push({
        label: `${label} principale (${nudity})`,
        group: `${group} — principale`,
        members: [preferred],
        preset: preset.name,
      })
    }
  }

  genderPasses(FEMALE_BODY_OUTPUT, 'Corpo base femminile', SMM_FEMALE_BODY_GROUP, opts.femalePreset)
  genderPasses(MALE_BODY_OUTPUT, 'Corpo base maschile', SMM_MALE_BODY_GROUP, opts.malePreset)
  return passes
}

/** SliderGroups XML per un gruppo sintetico (i nostri gruppi di enforcement). */
export function renderSliderGroupsXml(groups: { name: string; members: string[] }[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const body = groups
    .map(
      (g) =>
        `    <Group name="${esc(g.name)}">\n` +
        g.members.map((m) => `        <Member name="${esc(m)}"/>`).join('\n') +
        `\n    </Group>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<SliderGroups>\n${body}\n</SliderGroups>\n`
}

/**
 * Scansiona l'installazione BodySlide dentro una Data dir (tipicamente quella DEPLOYATA
 * del gioco: è l'unione di tutti i progetti delle mod). Tutto no-throw via BsFs.
 */
export function scanBodySlideAssets(dataDir: string, fs: BsFs): BodySlideAssets {
  const root = join(dataDir, BODYSLIDE_DIR_REL)
  const exePath = fs.exists(join(root, BODYSLIDE_EXE)) ? join(root, BODYSLIDE_EXE) : null

  const groups = new Set<string>()
  for (const f of fs.readdir(join(root, 'SliderGroups'))) {
    if (!/\.xml$/i.test(f)) continue
    const xml = fs.readFile(join(root, 'SliderGroups', f))
    if (xml) for (const g of parseGroupNames(xml)) groups.add(g)
  }

  const presets: BodySlidePreset[] = []
  const seen = new Set<string>()
  for (const f of fs.readdir(join(root, 'SliderPresets'))) {
    if (!/\.xml$/i.test(f)) continue
    const xml = fs.readFile(join(root, 'SliderPresets', f))
    if (!xml) continue
    for (const p of parseSliderPresets(xml, f)) {
      // Stesso nome in più file (mod diverse): tiene il primo, ordine readdir stabile.
      if (seen.has(p.name)) continue
      seen.add(p.name)
      presets.push(p)
    }
  }

  const setFiles = fs.readdir(join(root, 'SliderSets')).filter((f) => /\.osp$/i.test(f))
  const bodySets: BodySet[] = []
  const seenBody = new Set<string>()
  for (const f of setFiles) {
    const osp = fs.readFile(join(root, 'SliderSets', f))
    if (!osp) continue
    for (const b of parseBodySets(osp)) {
      if (b.output !== FEMALE_BODY_OUTPUT && b.output !== MALE_BODY_OUTPUT) continue // solo corpi base
      if (seenBody.has(b.name)) continue
      seenBody.add(b.name)
      bodySets.push(b)
    }
  }
  return {
    exePath,
    presets,
    // I nostri gruppi sintetici non sono "gruppi della collection": mai nei pass principali.
    groups: [...groups].filter((g) => !g.startsWith(SMM_GROUP_PREFIX)).sort(),
    setsCount: setFiles.length,
    bodySets,
  }
}

/** Quanti gruppi REALMENTE presenti copre un preset (metrica per il default). */
export function presetCoverage(p: BodySlidePreset, existingGroups: string[]): number {
  const have = new Set(existingGroups.map((g) => g.toLowerCase()))
  return p.groups.filter((g) => have.has(g.toLowerCase())).length
}

const isHimbo = (s: string): boolean => /himbo/i.test(s)

export interface BuildPass {
  label: string
  preset: string
  groups: string[]
}

export interface BuildPlan {
  passes: BuildPass[]
  /** Gruppi esclusi da ogni pass (nessun preset applicabile) — solo informativo. */
  uncovered: string[]
  /** Pass di enforcement del corpo base (nude/nevernude), da costruire DOPO i pass principali. */
  enforce: EnforcePass[]
  error?: string
}

/**
 * Piano di build deterministico:
 *   1. corpo femminile + tutti gli outfit non-HIMBO col preset scelto (default: il
 *      preset con la copertura gruppi più ampia — nella collection è quello del
 *      curatore, che elenca i gruppi dei suoi outfit);
 *   2. corpo/outfit maschili (gruppi HIMBO) col miglior preset HIMBO, se presenti;
 *   3. enforcement corpo base della nudità scelta (default NUDE): ricostruisce per ultimo
 *      femalebody/malebody nella variante voluta, così nevernude non lo clobbera (i due
 *      condividono file e gruppo — vedi planBodyEnforcement).
 * I gruppi di altri body type senza preset dedicato restano nel pass 1: dove i nomi
 * slider non combaciano BodySlide costruisce la forma base — mesh comunque valide.
 */
export function planBuildPasses(
  assets: BodySlideAssets,
  chosenPreset?: string,
  nudity: 'nude' | 'nevernude' = 'nude',
): BuildPlan {
  if (!assets.groups.length) return { passes: [], uncovered: [], enforce: [], error: 'nessun gruppo BodySlide trovato (deploy non eseguito?)' }
  if (!assets.presets.length) return { passes: [], uncovered: [], enforce: [], error: 'nessun preset BodySlide trovato' }

  const byCoverage = [...assets.presets].sort(
    (a, b) => presetCoverage(b, assets.groups) - presetCoverage(a, assets.groups) || a.name.localeCompare(b.name),
  )
  const female =
    (chosenPreset && assets.presets.find((p) => p.name === chosenPreset)) || byCoverage.find((p) => !isHimbo(p.name)) || byCoverage[0]

  const himboGroups = assets.groups.filter(isHimbo)
  const femaleGroups = assets.groups.filter((g) => !isHimbo(g))

  const passes: BuildPass[] = []
  if (femaleGroups.length) passes.push({ label: 'Corpo e outfit (femminili)', preset: female.name, groups: femaleGroups })

  const himboPreset = byCoverage.find((p) => isHimbo(p.name))
  if (himboGroups.length && himboPreset && himboPreset.name !== female.name)
    passes.push({ label: 'Corpo e outfit (HIMBO)', preset: himboPreset.name, groups: himboGroups })

  const uncovered = himboGroups.length && !himboPreset ? himboGroups : []
  // Senza preset HIMBO i gruppi maschili restano comunque costruiti nel pass femminile
  // (slider non combacianti → forma base): meglio di outfit non adattati del tutto.
  if (uncovered.length && passes.length) passes[0].groups = assets.groups

  const enforce = planBodyEnforcement(assets.bodySets, {
    nudity,
    femalePreset: female,
    malePreset: himboPreset,
  })

  return { passes, uncovered, enforce }
}

/**
 * Spezza la lista gruppi in chunk la cui join con virgola resta sotto maxChars:
 * la command line Windows ha un tetto (~32k) e i nomi gruppo sono centinaia.
 */
export function chunkGroups(groups: string[], maxChars = 24_000): string[][] {
  const chunks: string[][] = []
  let cur: string[] = []
  let len = 0
  for (const g of groups) {
    if (cur.length && len + g.length + 1 > maxChars) {
      chunks.push(cur)
      cur = []
      len = 0
    }
    cur.push(g)
    len += g.length + 1
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** Argomenti CLI di UN invocazione (un chunk di gruppi). */
export function buildBodySlideArgs(preset: string, groups: string[], targetDir: string): string[] {
  return ['--groupbuild', groups.join(','), '--preset', preset, '--targetdir', targetDir, '--trimorphs']
}

/**
 * Config.xml minimale per il run headless: TargetGame 4 (SkyrimSE), GameDataPath
 * sulla Data del gioco, scan BSA spento (inutile senza preview, lento con ~2000 mod).
 * Il chiamante la scrive come FILE REALE al posto dell'hardlink deployato.
 */
export function renderBodySlideConfig(gameDataPath: string): string {
  const dataPath = gameDataPath.replace(/\//g, '\\').replace(/\\?$/, '\\')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Config>
    <TargetGame>4</TargetGame>
    <WarnMissingGamePath>false</WarnMissingGamePath>
    <BSATextureScan>false</BSATextureScan>
    <GameDataPath>${esc(dataPath)}</GameDataPath>
    <GameDataPaths>
        <SkyrimSpecialEdition>${esc(dataPath)}</SkyrimSpecialEdition>
    </GameDataPaths>
    <DefaultGroups includeInBuild="true"></DefaultGroups>
</Config>
`
}

// ── Prerequisiti fisiche/scheletro ───────────────────────────────────────────
// BodySlide produce mesh CON i pesi fisici del progetto (3BA porta bone SMP/CBP);
// perché si MUOVANO in gioco servono i framework runtime. Qui solo diagnosi.

export interface PhysicsPrereqs {
  /** Corpo base femminile (CBBE / 3BA) presente. */
  body: boolean
  /** CBPC — fisiche collision-based (minimo indispensabile). */
  cbpc: boolean
  /** FSMP / HDT-SMP — fisiche cloth/capelli avanzate. */
  fsmp: boolean
  /** XP32 Maximum Skeleton (i bone fisici stanno qui). */
  skeleton: boolean
}

export function checkPhysicsPrereqs(enabledModNames: string[]): PhysicsPrereqs {
  const has = (re: RegExp) => enabledModNames.some((n) => re.test(n))
  return {
    body: has(/\bcbbe\b|3ba|3bbb/i),
    cbpc: has(/\bcbpc\b/i),
    fsmp: has(/\bfsmp\b|faster\s*hdt|hdt-?smp/i),
    skeleton: has(/xp32|xpmsse/i),
  }
}
