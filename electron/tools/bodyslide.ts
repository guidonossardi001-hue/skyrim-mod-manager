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
  /** Nomi gruppo unici dichiarati in SliderGroups/*.xml. */
  groups: string[]
  /** Progetti .osp in SliderSets (indicatore di copertura outfit). */
  setsCount: number
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

  const setsCount = fs.readdir(join(root, 'SliderSets')).filter((f) => /\.osp$/i.test(f)).length
  return { exePath, presets, groups: [...groups].sort(), setsCount }
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
  error?: string
}

/**
 * Piano di build deterministico in DUE pass:
 *   1. corpo femminile + tutti gli outfit non-HIMBO col preset scelto (default: il
 *      preset con la copertura gruppi più ampia — nella collection è quello del
 *      curatore, che elenca i gruppi dei suoi outfit);
 *   2. corpo/outfit maschili (gruppi HIMBO) col miglior preset HIMBO, se presenti.
 * I gruppi di altri body type senza preset dedicato restano nel pass 1: dove i nomi
 * slider non combaciano BodySlide costruisce la forma base — mesh comunque valide.
 */
export function planBuildPasses(assets: BodySlideAssets, chosenPreset?: string): BuildPlan {
  if (!assets.groups.length) return { passes: [], uncovered: [], error: 'nessun gruppo BodySlide trovato (deploy non eseguito?)' }
  if (!assets.presets.length) return { passes: [], uncovered: [], error: 'nessun preset BodySlide trovato' }

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

  return { passes, uncovered }
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
