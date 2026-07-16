import { describe, it, expect } from 'vitest'
import { detectExclusionConflicts, isDerivative, normalizeName, type ExclusionMod } from './exclusionGroups'

const mods = (...names: string[]): ExclusionMod[] => names.map((name, i) => ({ id: i + 1, name }))
const labels = (list: ExclusionMod[]) => detectExclusionConflicts(list).map((h) => h.label).sort()

describe('isDerivative', () => {
  it('riconosce armature, bodyslide, preset, config, patch e texture come derivati', () => {
    for (const n of [
      'DX Dark Knight Armor - SSE CBBE BodySlide',
      'Diamond CBBE 3BA Bodyslide v1.1',
      'Demonic Body Preset cbbe 3ba',
      '3B Breast-Butt Bounce Configs for 3BA-BHUNP-COCO',
      'Beyond Skyrim Bruma CBBE 3BA and HIMBO Patch',
      'Diamond Textures CBBE v2 based on FSC v11',
      'CBBE 3BA (3BBB) - Settings Loader',
      'skeleton patch for 3BA-BHUNP',
    ]) {
      expect(isDerivative(n), n).toBe(true)
    }
  })
  it('NON marca come derivati i framework veri', () => {
    for (const n of ['CBBE 3BA (3BBB)', "Caliente's Beautiful Bodies Enhancer CBBE - v2.0.3", 'Rudy ENB SE']) {
      expect(isDerivative(n), n).toBe(false)
    }
  })
})

describe('detectExclusionConflicts — i falsi positivi del caso reale (63/63 sulla Opoal Collection)', () => {
  it('CBBE + 3BA + il loro corredo di armature/preset NON è un conflitto (3BA è costruito su CBBE)', () => {
    expect(
      labels(
        mods(
          "Caliente's Beautiful Bodies Enhancer CBBE - v2.0.3",
          'CBBE 3BA (3BBB)',
          'CBBE 3BA (3BBB) - Settings Loader',
          'DX Dark Knight Armor - SSE CBBE BodySlide',
          'Elf Stalhrim Bikini Armor - CBBE 3BA',
          'Vigilant CBBE',
          'Hands Redone F CBBE',
        ),
      ),
    ).toEqual([])
  })

  it('HIMBO (body maschile) convive con CBBE (body femminile): slot diversi', () => {
    expect(labels(mods('CBBE 3BA (3BBB)', '01b) HIMBO V5 - Core (Nude Body with SOS or TNG)'))).toEqual([])
  })

  it('un nome che elenca più famiglie dichiara compatibilità, non concorrenza', () => {
    expect(
      labels(
        mods(
          'Amsedillir - Runes Of Roots (3BA BHUNP UBE)',
          'Narukami - hdt-SMP (CBBE 3BA - BHUNP)',
          '01b) HIMBO V5 - Core (Nude Body with SOS or TNG)',
        ),
      ),
    ).toEqual([])
  })

  it('le patch ENB Light sono un framework, non preset ENB concorrenti', () => {
    expect(
      labels(
        mods(
          'Apocrypha ENB Light',
          'Dark Elf Lantern ENB Light',
          'Sprites or Specters - ENB Light - Scrambled Bugs Version',
          'Winterhold Statue - Animated with ENB Lights',
        ),
      ),
    ).toEqual([])
  })

  it('"Klear Odin Valhalla Rising Rogue" è un armatura: `odin` non deve renderla un magic overhaul', () => {
    expect(
      labels(mods('Klear Odin Valhalla Rising Rogue 4002 CBBE 3BA SMP', 'Odin 3.1.5')),
    ).toEqual([])
  })

  it('CBPC e HDT-SMP convivono per progetto: nessuna esclusione tra i due', () => {
    expect(
      labels(mods('CBPC - Fomod installer - MAIN FILE', 'FSMP 3.5.0', 'Extra Skeleton Nodes - CBPC')),
    ).toEqual([])
  })

  it('"Souls of SOS" e "SOSVoicePack" sono addon, non il framework SOS', () => {
    expect(labels(mods('Souls of SOS', 'SOSVoicePack', 'The New Gentleman'))).toEqual([])
  })

  it('Apocalypse è uno spell pack additivo: con Mysticism non è un conflitto', () => {
    expect(labels(mods('Apocalypse 10.2.3', 'Mysticism - A Magic Overhaul'))).toEqual([])
  })

  it('le armature che consumano un body NON sono basi (31 nomi reali sfuggivano ai marker)', () => {
    expect(
      labels(
        mods(
          'Abyss 3BA',
          "Asura's Guard 3BA 2K",
          'DX St. Louis 3BA',
          'Dragons Crown Sorceress 3BA ESL',
          'BHUNP (UUNP Next Generation) SSE',
        ),
      ),
    ).toEqual([]) // solo BHUNP è una base: una sola famiglia → nessun conflitto
  })

  it('"Unpoisoned Blocking" non è UNP: i confini di parola reggono gli acronimi', () => {
    expect(labels(mods('Unpoisoned Blocking - Latest Version', 'CBBE 3BA (3BBB)'))).toEqual([])
  })

  it('ENB e ReShade convivono (Nolvus li spedisce appaiati): mai un conflitto', () => {
    expect(labels(mods('Rudy ENB SE', 'NOLVUS Reshade', 'Ljoss ReShade Preset'))).toEqual([])
  })
})

describe('detectExclusionConflicts — i conflitti VERI devono restare', () => {
  it('due body femminili di famiglie diverse: errore, e nomina i BODY non le armature', () => {
    const hits = detectExclusionConflicts(
      mods('Abyss 3BA', 'CBBE 3BA (3BBB)', 'BHUNP (UUNP Next Generation) SSE'),
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ label: 'body femminile', severity: 'error' })
    expect(hits[0].families.sort()).toEqual(['CBBE', 'UNP'])
    expect(hits[0].members.map((m) => m.name)).toEqual(['CBBE 3BA (3BBB)', 'BHUNP (UUNP Next Generation) SSE'])
  })

  it('il nome REALE di BHUNP ("BHUNP 3BBB Advanced") scatta contro CBBE — 3BBB è terminologia condivisa', () => {
    const hits = detectExclusionConflicts(
      mods("Caliente's Beautiful Bodies Enhancer CBBE - v2.0.3", 'BHUNP 3BBB Advanced Ver 3'),
    )
    expect(hits.map((h) => h.label)).toEqual(['body femminile'])
  })

  it('due preset ENB veri: singleton, conflitto anche a parità di famiglia — e "Preset" nel nome non li scarta', () => {
    const hits = detectExclusionConflicts(
      mods('Rudy ENB SE', 'Silent Horizons ENB Preset', 'Apocrypha ENB Light', 'Winterhold Statue - Animated with ENB Lights'),
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].label).toBe('preset ENB')
    expect(hits[0].members.map((m) => m.name)).toEqual(['Rudy ENB SE', 'Silent Horizons ENB Preset'])
  })

  it('SOS e TNG restano alternativi tra loro', () => {
    const hits = detectExclusionConflicts(mods('SOS - Schlongs of Skyrim SE', 'TNG - The New Gentleman'))
    expect(hits.map((h) => h.label)).toEqual(['genitali maschili'])
  })

  it('HDT-SMP e FSMP sono due motori dello stesso tipo: errore ("Do not install it together with FSMP")', () => {
    const hits = detectExclusionConflicts(mods('HDT-SMP (Skinned Mesh Physics)', 'FSMP - Faster HDT-SMP'))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ label: 'motore SMP', severity: 'error' })
    expect(hits[0].families.sort()).toEqual(['FSMP', 'HDT-SMP'])
  })

  it('due perk overhaul: conflitto — ma un merge Vokriinator lo risolve', () => {
    expect(labels(mods('Ordinator - Perks of Skyrim', 'Vokrii - Minimalistic Perks'))).toEqual(['perk overhaul'])
    expect(
      labels(mods('Ordinator - Perks of Skyrim', 'Vokrii - Minimalistic Perks', 'Vokriinator Black')),
    ).toEqual([])
  })

  it('Odin vs Mysticism: conflitto, salvo patch cross-famiglia dichiarata dal curatore', () => {
    expect(labels(mods('Odin 3.1.5', 'Mysticism - A Magic Overhaul'))).toEqual(['magic overhaul'])
    expect(labels(mods('Odin 3.1.5', 'Mysticism - A Magic Overhaul', 'Patch - Mysticism'))).toEqual([])
  })

  it('due body maschili di famiglie diverse: errore, anche col prefisso d ordinamento del curatore', () => {
    const hits = detectExclusionConflicts(mods('01b) HIMBO V5 - Core (Nude Body with SOS or TNG)', 'SAM Light SE'))
    expect(hits.map((h) => h.label)).toEqual(['body maschile'])
  })

  it('nessuna mod, o una sola base per gruppo: nessun conflitto', () => {
    expect(detectExclusionConflicts([])).toEqual([])
    expect(labels(mods('CBBE 3BA (3BBB)', 'Rudy ENB SE', 'Ordinator - Perks of Skyrim'))).toEqual([])
  })
})

describe('normalizeName', () => {
  it('toglie i prefissi d ordinamento dei curatori, non i nomi che iniziano per cifra', () => {
    expect(normalizeName('01b) HIMBO V5 - Core')).toBe('himbo v5 - core')
    expect(normalizeName('02 - CBBE 3BA')).toBe('cbbe 3ba')
    expect(normalizeName('00 Core')).toBe('core')
    expect(normalizeName('3B Breast-Butt Bounce Configs')).toBe('3b breast-butt bounce configs')
    expect(normalizeName('CBBE 3BA (3BBB)')).toBe('cbbe 3ba (3bbb)')
  })
})
