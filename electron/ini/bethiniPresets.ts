import type { IniFileMap, IniTemplate } from './iniService'

// Preset INI derivati da BethINI Pie (T18) — NON è un import del dataset completo del progetto
// (github.com/DoubleYouC/Bethini-Pie-Skyrim-Special-Edition-Plugin, settings.json, licenza
// CC BY-NC-SA 4.0 — non redistribuibile qui per uso non-commerciale/attribuzione): sono valori
// chiave/sezione/tier ricavati dalla ricerca (documentati alla pagina Nexus site/631 e nel repo
// pubblico) e riscritti a mano come tabella curata, applicati con lo stesso editor line-oriented
// di iniService (mai un parse→reserialize che distrugga le personalizzazioni dell'utente).
//
// Due "flavor":
//   • bethini — i valori OTTIMIZZATI che BethINI Pie applica di suo (preset Poor/Low/../Ultra).
//   • vanilla — i valori che i preset ufficiali low.ini/medium.ini/high.ini/ultra.ini di Bethesda
//     (distribuiti nella cartella d'installazione del gioco) userebbero — nessun tier "poor".
//
// Categorie coperte (quelle con numeri esatti confermati dalla ricerca): Grass, Distant Detail,
// Shadow Resolution. Non tutte le categorie di BethINI Pie sono qui: solo quelle con valori
// per-tier verificati da fonte primaria, per non inventare numeri.

export type BethiniTier = 'poor' | 'low' | 'medium' | 'high' | 'ultra'
export type BethiniFlavor = 'bethini' | 'vanilla'

interface BethiniKey {
  name: string
  section: string
  ini: 'Skyrim.ini' | 'SkyrimPrefs.ini'
  bethini: Partial<Record<BethiniTier, number>>
  vanilla: Partial<Record<BethiniTier, number>> // mai 'poor': i preset vanilla Bethesda non hanno quel tier
}

const BETHINI_KEYS: BethiniKey[] = [
  {
    name: 'iMinGrassSize',
    section: 'Grass',
    ini: 'Skyrim.ini',
    bethini: { poor: 100, low: 40, medium: 40, high: 40, ultra: 40 },
    vanilla: { low: 20, medium: 20, high: 20, ultra: 20 },
  },
  {
    name: 'fGrassStartFadeDistance',
    section: 'Grass',
    ini: 'SkyrimPrefs.ini',
    bethini: { poor: 0.0, low: 512.0, medium: 1024.0, high: 4096.0, ultra: 6144.0 },
    vanilla: { low: 1000, medium: 2300, high: 7000, ultra: 7000 },
  },
  {
    name: 'fGrassFadeRange',
    section: 'Grass',
    ini: 'Skyrim.ini',
    bethini: { poor: 0, low: 1766, medium: 3532, high: 6144, ultra: 14128 },
    vanilla: { low: 1000, medium: 1000, high: 1000, ultra: 1000 },
  },
  {
    name: 'fBlockLevel0Distance',
    section: 'TerrainManager',
    ini: 'SkyrimPrefs.ini',
    bethini: { poor: 12288, low: 16384, medium: 32768, high: 53248, ultra: 57344 },
    vanilla: { low: 15000, medium: 20000, high: 35000, ultra: 60000 },
  },
  {
    name: 'fBlockLevel1Distance',
    section: 'TerrainManager',
    ini: 'SkyrimPrefs.ini',
    bethini: { poor: 24576, low: 32768, medium: 81920, high: 114688, ultra: 147456 },
    vanilla: { low: 25000, medium: 32000, high: 70000, ultra: 90000 },
  },
  {
    name: 'fBlockMaximumDistance',
    section: 'TerrainManager',
    ini: 'SkyrimPrefs.ini',
    bethini: { poor: 65536, low: 131072, medium: 196608, high: 262144, ultra: 327680 },
    vanilla: { low: 100000, medium: 100000, high: 250000, ultra: 250000 },
  },
  {
    name: 'fSplitDistanceMult',
    section: 'TerrainManager',
    ini: 'SkyrimPrefs.ini',
    bethini: { poor: 1, low: 1, medium: 1, high: 1, ultra: 1 },
    vanilla: { low: 0.5, medium: 1.1, high: 1.5, ultra: 1.5 },
  },
  {
    name: 'iShadowMapResolution',
    section: 'Display',
    ini: 'SkyrimPrefs.ini',
    bethini: { poor: 2, low: 512, medium: 1024, high: 2048, ultra: 4096 },
    vanilla: { low: 1024, medium: 2048, high: 2048, ultra: 4096 },
  },
]

export const BETHINI_TIERS_BY_FLAVOR: Record<BethiniFlavor, BethiniTier[]> = {
  bethini: ['poor', 'low', 'medium', 'high', 'ultra'],
  vanilla: ['low', 'medium', 'high', 'ultra'],
}

/** Costruisce la mappa file→sezione→chiave→valore per un tier/flavor. Chiavi senza valore per quel tier sono omesse (mai un 0 inventato). */
export function buildBethiniIniMap(tier: BethiniTier, flavor: BethiniFlavor): IniFileMap {
  const out: IniFileMap = {}
  for (const k of BETHINI_KEYS) {
    const value = k[flavor][tier]
    if (value === undefined) continue
    out[k.ini] ??= {}
    out[k.ini][k.section] ??= {}
    out[k.ini][k.section][k.name] = value
  }
  return out
}

export function bethiniPresetTemplate(tier: BethiniTier, flavor: BethiniFlavor): IniTemplate {
  return { name: `BethINI ${flavor} ${tier}`, settings: buildBethiniIniMap(tier, flavor) }
}

export function isValidBethiniTier(flavor: BethiniFlavor, tier: string): tier is BethiniTier {
  return (BETHINI_TIERS_BY_FLAVOR[flavor] as string[]).includes(tier)
}
