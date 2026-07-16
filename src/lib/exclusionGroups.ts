// Rilevamento dei gruppi a mutua esclusione (un solo body replacer, un solo preset ENB, …).
//
// Il modello precedente — substring nudo del keyword nel nome della mod — dava il 100% di falsi
// positivi su una collection reale (63/63 su 1939 mod attive): "cbbe" becca ogni armatura
// convertita per CBBE, "enb" becca le patch ENB Light, "odin" becca l'armatura "Klear Odin
// Valhalla Rising Rogue". Un framework e i suoi CONSUMATORI hanno lo stesso keyword nel nome.
//
// Modello corretto, quattro regole:
//   1. BASE SU WHITELIST ANCORATA. I framework sono pochi e noti e mettono il proprio nome in
//      TESTA ("CBBE 3BA (3BBB)", "FSMP 3.5.0"); i consumatori lo portano in coda o in mezzo
//      ("Abyss 3BA", "Wind Ruler Armor SE - hdt-SMP"). Ancorare è l'unica regola che regge: il
//      filtro sui marker derivati da solo lasciava passare 31 armature su 54 come "base CBBE",
//      col rischio di attribuire il conflitto a un'armatura invece che al body.
//   2. FAMIGLIE, non keyword sciolti. L'esclusione è TRA famiglie, non dentro: CBBE e CBBE 3BA
//      devono coesistere (3BA è costruito su CBBE), CBBE e BHUNP no.
//   3. DERIVATI esclusi comunque (bodyslide, preset, patch, config, texture): seconda barriera
//      per i nomi che iniziano col framework ma ne sono add-on ("CBBE 3BA - Settings Loader").
//   4. RISOLTO DA. Una patch/merge cross-famiglia dichiara che la coesistenza è voluta
//      (Vokriinator per i perk, "Patch - Mysticism" per la magia): sopprime il gruppo.
//
// Limite noto e accettato: SAM Light incorpora già i genitali, quindi SAM + SOS/TNG è
// un'esclusione reale che lo split body/genitali non vede. Falso NEGATIVO, coerente con la
// politica del file: mancare una segnalazione costa meno che allarmare su ogni armatura.
// Puro, senza DOM/DB → interamente testabile.

export interface ExclusionMod {
  id: number
  name: string
}

export interface ExclusionHit {
  label: string
  severity: 'warning' | 'error'
  /** Le mod BASE in conflitto. */
  members: ExclusionMod[]
  /** Le famiglie coinvolte (≥2 in modalità 'families'). */
  families: string[]
}

interface Family {
  family: string
  patterns: RegExp[]
}

interface Group {
  label: string
  severity: 'warning' | 'error'
  families: Family[]
  /**
   * 'families' (default): conflitto tra famiglie diverse, dentro la famiglia si impila
   *   (CBBE + 3BA = corretto; CBBE + BHUNP = conflitto).
   * 'singleton': ogni base esclude le altre, anche della stessa famiglia
   *   (due preset ENB restano due preset ENB).
   */
  mode?: 'families' | 'singleton'
  /** Nomi che contengono uno di questi NON sono mai base del gruppo (framework omonimi). */
  notPatterns?: RegExp[]
  /** Se una mod attiva matcha, la coesistenza è dichiarata voluta: il gruppo non segnala. */
  resolvedBy?: RegExp[]
  /** Override dei marker derivati (default DERIVATIVE_MARKERS). */
  derivativeMarkers?: string[]
}

/**
 * Marker di una mod DERIVATA: consuma un framework invece di competerci. Seconda barriera dopo
 * l'ancoraggio — un falso "derivato" costa una mancata segnalazione su una mod dal nome atipico,
 * un falso "base" costa un allarme su ogni armatura della collection (il bug che correggiamo).
 */
export const DERIVATIVE_MARKERS = [
  'patch',
  'patches',
  'config',
  'preset',
  'bodyslide',
  'conversion',
  'conversions',
  'addon',
  'add-on',
  'armor',
  'armour',
  'outfit',
  'robes',
  'dress',
  'bikini',
  'skirt',
  'skeleton',
  'texture',
  'normal map',
  'compatibility',
  'consistency',
  'fix',
  'tweak',
  'icon',
  'settings loader',
  'replacer for',
  'physics',
  'refit',
  'slider',
  'voicepack',
  'voice pack',
]

/**
 * Toglie i prefissi d'ordinamento che i curatori mettono davanti al nome ("01b) HIMBO V5 - Core"):
 * senza questo l'ancoraggio ^ manca il framework proprio nelle collection, che è dove serve.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*\d{1,3}[a-z]?\s*[).\]\-–_]\s+/, '') // "01b) …", "02 - …"
    .replace(/^\s*\d{1,3}\s+/, '') // "00 Core"
    .trim()
}

/** True se il nome denuncia un derivato (armatura/patch/preset/config/…), non un framework. */
export function isDerivative(name: string, markers: string[] = DERIVATIVE_MARKERS): boolean {
  const n = name.toLowerCase()
  return markers.some((m) => n.includes(m))
}

// I preset grafici SONO preset: qui 'preset' come marker derivato spegnerebbe il gruppo
// ("Rudy ENB Preset", "Ljoss ReShade Preset" sono basi, non derivati).
const ENB_MARKERS = DERIVATIVE_MARKERS.filter((m) => m !== 'preset')
// Il motore SMP porta 'physics' NEL PROPRIO NOME ("HDT-SMP (Skinned Mesh Physics)"): col marker
// generico il gruppo non scatterebbe mai. Le patch SMP restano derivate per gli altri marker
// (armor/outfit/robes/skirt/conversion), quindi togliere 'physics' qui non apre falle.
const SMP_MARKERS = DERIVATIVE_MARKERS.filter((m) => m !== 'physics')

export const EXCLUSION_GROUPS: Group[] = [
  {
    // Body FEMMINILE. Le famiglie sono i lignaggi incompatibili; dentro la famiglia le mod si
    // impilano (CBBE → 3BA → preset). NB: '3BBB' NON sta tra i pattern CBBE — è terminologia
    // condivisa col lignaggio UUNP e il main file vero di BHUNP si chiama "BHUNP 3BBB Advanced":
    // includerlo rendeva BHUNP un nome "multi-famiglia" e spegneva il conflitto di punta.
    // UBE è fuori di proposito: è race-based (razze proprie), convive con CBBE sulle razze
    // vanilla — l'incompatibilità è a livello di preset/outfit, non un conflitto di body.
    label: 'body femminile',
    severity: 'error',
    families: [
      { family: 'CBBE', patterns: [/^cbbe\b/, /^caliente'?s beautiful bodies\b/] },
      { family: 'UNP', patterns: [/^bhunp\b/, /^unp\b/, /^unpb\b/, /^uunp\b/] },
    ],
  },
  {
    // Body MASCHILE: slot diverso dal femminile (HIMBO e CBBE convivono da sempre) — tenerli nello
    // stesso gruppo, com'era, segnalava come conflitto un'installazione corretta.
    label: 'body maschile',
    severity: 'error',
    families: [
      { family: 'HIMBO', patterns: [/^himbo\b/] },
      { family: 'SAM', patterns: [/^sam light\b/, /^shape atlas for men\b/] },
      { family: 'Better Males', patterns: [/^better males\b/] },
    ],
  },
  {
    // Genitali maschili: framework a sé, convivono col body (HIMBO è compatibile con SOS e TNG).
    // SOS e TNG sono invece alternativi: la doc di TNG impone di disinstallare SOS.
    // Ancorate: "Souls of SOS" e "SOSVoicePack" sono addon, non il framework.
    label: 'genitali maschili',
    severity: 'warning',
    families: [
      { family: 'SOS', patterns: [/^sos\b/, /^schlongs of skyrim\b/] },
      { family: 'TNG', patterns: [/^tng\b/, /^the new gentleman\b/] },
    ],
  },
  {
    // PRESET ENB (Rudy, Silent Horizons, …): singleton — due preset sono due preset.
    // "ENB Light" è un ALTRO progetto: framework di luci particellari con una patch per mod
    // (Apocrypha ENB Light, …). Nessun preset vero ha 'light' nel nome, l'intero ecosistema
    // particle-lights sì: è il discrimine più robusto delle varianti lessicali.
    // ReShade NON sta qui: convive con ENB (Nolvus li spedisce appaiati, ENB via d3d11.dll +
    // ReShade via dxgi.dll con ProxyLibrary) — dichiararli esclusivi era un conflitto inventato.
    label: 'preset ENB',
    severity: 'warning',
    mode: 'singleton',
    derivativeMarkers: ENB_MARKERS,
    families: [{ family: 'ENB', patterns: [/\benb\b/] }],
    notPatterns: [/light/, /particle/, /\benb ?series\b/, /\benb ?helper\b/, /\benb ?dev\b/],
  },
  {
    // Motore SMP. CBPC e SMP convivono per progetto (CBPC = collisioni corpo, SMP = stoffa/capelli):
    // il vecchio gruppo "physics" che li dichiarava esclusivi è stato rimosso. Resta un'esclusione
    // vera e dichiarata dall'autore — FAQ di FSMP: "Do not install it together with FSMP".
    // Ancorate: senza ^, "FSMP - Faster HDT-SMP" toccherebbe entrambe le famiglie e la regola
    // multi-famiglia lo scarterebbe, spegnendo il gruppo per sempre.
    label: 'motore SMP',
    severity: 'error',
    derivativeMarkers: SMP_MARKERS,
    families: [
      { family: 'HDT-SMP', patterns: [/^hdt[- ]?smp\b/] },
      { family: 'FSMP', patterns: [/^fsmp\b/, /^faster hdt[- ]?smp\b/] },
    ],
  },
  {
    label: 'perk overhaul',
    severity: 'warning',
    // I merge SONO la risoluzione del conflitto, non una sua vittima.
    resolvedBy: [/^vokriinator\b/, /^vokord\b/],
    families: [
      { family: 'Ordinator', patterns: [/^ordinator\b/] },
      { family: 'Vokrii', patterns: [/^vokrii\b/] },
      { family: 'Adamant', patterns: [/^adamant\b/] },
    ],
  },
  {
    // Apocalypse è uno spell pack ADDITIVO (aggiunge incantesimi nuovi, non tocca i vanilla):
    // non appartiene a un gruppo a mutua esclusione. Metterlo qui produceva l'unico conflitto
    // residuo della collection reale — un falso positivo. Restano Odin (EnaiRim) e Mysticism
    // (Simonrim), che rifanno entrambi la magia vanilla; una patch cross-famiglia li concilia.
    label: 'magic overhaul',
    severity: 'warning',
    resolvedBy: [/mysticism.*\bpatch\b/, /\bpatch\b.*mysticism/, /odin.*mysticism/],
    families: [
      { family: 'EnaiRim', patterns: [/^odin\b/] },
      { family: 'Simonrim', patterns: [/^mysticism\b/] },
    ],
  },
  {
    // "Mortal Enemies" (angoli/tracking) non è un overhaul del combattimento: conviveva con tutto
    // e finiva segnalato contro sé stesso in tre varianti.
    label: 'combat overhaul',
    severity: 'warning',
    families: [
      { family: 'Valhalla', patterns: [/^valhalla combat\b/] },
      { family: 'Wildcat', patterns: [/^wildcat\b/] },
      { family: 'Blade & Blunt', patterns: [/^blade (and|&) blunt\b/] },
    ],
  },
]

/** Famiglie del gruppo che il nome tocca (senza filtri: serve anche per la regola multi-famiglia). */
function matchedFamilies(group: Group, nname: string): string[] {
  return group.families.filter((f) => f.patterns.some((p) => p.test(nname))).map((f) => f.family)
}

/**
 * Conflitti di mutua esclusione: un gruppo conflagra solo quando ≥2 mod base attive di famiglie
 * diverse ('families') o ≥2 base qualsiasi ('singleton'). Derivati, nomi multi-famiglia e gruppi
 * risolti da una patch dichiarata non contano.
 */
export function detectExclusionConflicts(mods: ExclusionMod[]): ExclusionHit[] {
  const normalized = mods.map((mod) => ({ mod, nname: normalizeName(mod.name) }))
  const hits: ExclusionHit[] = []
  for (const group of EXCLUSION_GROUPS) {
    if (group.resolvedBy?.some((p) => normalized.some((n) => p.test(n.nname)))) continue
    const markers = group.derivativeMarkers ?? DERIVATIVE_MARKERS
    const singleton = group.mode === 'singleton'
    const bases: { mod: ExclusionMod; family: string }[] = []
    const claimed = new Set<string>()
    for (const { mod, nname } of normalized) {
      if (group.notPatterns?.some((p) => p.test(nname))) continue
      const fams = matchedFamilies(group, nname)
      if (fams.length !== 1) continue // 0 = estraneo · ≥2 = "supporta X o Y", non un concorrente
      if (isDerivative(mod.name, markers)) continue
      if (!singleton) {
        if (claimed.has(fams[0])) continue // la famiglia si impila: basta un rappresentante
        claimed.add(fams[0])
      }
      bases.push({ mod, family: fams[0] })
    }
    if (bases.length > 1) {
      hits.push({
        label: group.label,
        severity: group.severity,
        members: bases.map((b) => b.mod),
        families: [...new Set(bases.map((b) => b.family))],
      })
    }
  }
  return hits
}
