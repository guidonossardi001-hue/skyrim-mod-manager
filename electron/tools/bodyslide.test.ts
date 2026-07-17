import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  parseSliderPresets,
  parseGroupNames,
  scanBodySlideAssets,
  planBuildPasses,
  presetCoverage,
  chunkGroups,
  buildBodySlideArgs,
  renderBodySlideConfig,
  checkPhysicsPrereqs,
  BODYSLIDE_DIR_REL,
  type BsFs,
  type BodySlideAssets,
} from './bodyslide'

const PRESET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SliderPresets>
    <Preset name="ErinPreset" set="[Erin] CBBE 3BBB Body Amazing">
        <Group name="3BA"/>
        <Group name="CBBE"/>
        <Group name="TAWOBA &amp; friends"/>
        <SetSlider name="Breasts" size="big" value="32"/>
    </Preset>
    <Preset name="HIMBO" set="HIMBO">
        <Group name="HIMBO"/>
    </Preset>
</SliderPresets>`

const GROUPS_XML = `<SliderGroups>
    <Group name="3BA">
        <Member name="3BA Body Amazing"/>
    </Group>
    <Group name="CBBE"><Member name="CBBE Body"/></Group>
    <Group name="HIMBO"><Member name="HIMBO Body"/></Group>
</SliderGroups>`

describe('parseSliderPresets', () => {
  it('estrae nome, set e gruppi (con decode entità XML)', () => {
    const presets = parseSliderPresets(PRESET_XML, 'p.xml')
    expect(presets.map((p) => p.name)).toEqual(['ErinPreset', 'HIMBO'])
    expect(presets[0].set).toBe('[Erin] CBBE 3BBB Body Amazing')
    expect(presets[0].groups).toContain('TAWOBA & friends')
    expect(presets[1].groups).toEqual(['HIMBO'])
  })

  it('XML malformato o vuoto → lista vuota, mai throw', () => {
    expect(parseSliderPresets('', 'x')).toEqual([])
    expect(parseSliderPresets('<Preset>senza nome</Preset>', 'x')).toEqual([])
    expect(parseSliderPresets('garbage <<<>>>', 'x')).toEqual([])
  })
})

describe('parseGroupNames', () => {
  it('estrae i nomi gruppo', () => {
    expect(parseGroupNames(GROUPS_XML)).toEqual(['3BA', 'CBBE', 'HIMBO'])
  })
})

function fakeFs(files: Record<string, string>, dirs: Record<string, string[]>): BsFs {
  const norm = (p: string) => p.replace(/\\/g, '/')
  return {
    exists: (p) => norm(p) in files,
    readdir: (p) => dirs[norm(p)] ?? [],
    readFile: (p) => files[norm(p)] ?? null,
  }
}

const DATA = 'C:/game/Data'
const BS = `${DATA}/CalienteTools/BodySlide`

describe('scanBodySlideAssets', () => {
  it('trova exe, gruppi, preset e conta gli .osp', () => {
    const fs = fakeFs(
      {
        [`${BS}/BodySlide.exe`]: 'exe',
        [`${BS}/SliderGroups/g.xml`]: GROUPS_XML,
        [`${BS}/SliderPresets/p.xml`]: PRESET_XML,
      },
      {
        [`${BS}/SliderGroups`]: ['g.xml', 'readme.txt'],
        [`${BS}/SliderPresets`]: ['p.xml'],
        [`${BS}/SliderSets`]: ['a.osp', 'b.OSP', 'note.txt'],
      },
    )
    const a = scanBodySlideAssets(DATA, fs)
    expect(a.exePath).toBe(join(DATA, BODYSLIDE_DIR_REL, 'BodySlide.exe'))
    expect(a.groups).toEqual(['3BA', 'CBBE', 'HIMBO'])
    expect(a.presets.map((p) => p.name)).toEqual(['ErinPreset', 'HIMBO'])
    expect(a.setsCount).toBe(2)
  })

  it('preset omonimi in file diversi: tiene il primo', () => {
    const fs = fakeFs(
      {
        [`${BS}/SliderPresets/a.xml`]: '<Preset name="X" set="A"><Group name="G1"/></Preset>',
        [`${BS}/SliderPresets/b.xml`]: '<Preset name="X" set="B"><Group name="G2"/></Preset>',
      },
      { [`${BS}/SliderPresets`]: ['a.xml', 'b.xml'] },
    )
    const a = scanBodySlideAssets(DATA, fs)
    expect(a.presets).toHaveLength(1)
    expect(a.presets[0].set).toBe('A')
  })

  it('albero assente → risultato vuoto, mai throw', () => {
    const a = scanBodySlideAssets(DATA, fakeFs({}, {}))
    expect(a).toEqual({ exePath: null, presets: [], groups: [], setsCount: 0 })
  })
})

const assets = (over: Partial<BodySlideAssets> = {}): BodySlideAssets => ({
  exePath: `${BS}/BodySlide.exe`,
  presets: [
    { name: 'ErinPreset', set: 'Erin', groups: ['3BA', 'CBBE'], file: 'p.xml' },
    { name: 'Slim', set: 'CBBE', groups: ['CBBE'], file: 'q.xml' },
    { name: 'HIMBO', set: 'HIMBO', groups: ['HIMBO'], file: 'h.xml' },
  ],
  groups: ['3BA', 'CBBE', 'HIMBO', 'HIMBO Outfits'],
  setsCount: 10,
  ...over,
})

describe('planBuildPasses', () => {
  it('default: preset a copertura massima per i gruppi femminili + pass HIMBO separato', () => {
    const plan = planBuildPasses(assets())
    expect(plan.error).toBeUndefined()
    expect(plan.passes).toHaveLength(2)
    expect(plan.passes[0].preset).toBe('ErinPreset')
    expect(plan.passes[0].groups).toEqual(['3BA', 'CBBE'])
    expect(plan.passes[1].preset).toBe('HIMBO')
    expect(plan.passes[1].groups).toEqual(['HIMBO', 'HIMBO Outfits'])
  })

  it('preset scelto dall’utente vince sul default', () => {
    const plan = planBuildPasses(assets(), 'Slim')
    expect(plan.passes[0].preset).toBe('Slim')
  })

  it('preset scelto inesistente → fallback al default (mai un nome arbitrario nello spawn)', () => {
    const plan = planBuildPasses(assets(), '../../evil')
    expect(plan.passes[0].preset).toBe('ErinPreset')
  })

  it('senza preset HIMBO i gruppi maschili confluiscono nel pass unico', () => {
    const a = assets({ presets: [{ name: 'ErinPreset', set: 'Erin', groups: ['3BA'], file: 'p.xml' }] })
    const plan = planBuildPasses(a)
    expect(plan.passes).toHaveLength(1)
    expect(plan.passes[0].groups).toEqual(a.groups)
    expect(plan.uncovered).toEqual(['HIMBO', 'HIMBO Outfits'])
  })

  it('nessun gruppo o nessun preset → errore parlante', () => {
    expect(planBuildPasses(assets({ groups: [] })).error).toMatch(/gruppo/)
    expect(planBuildPasses(assets({ presets: [] })).error).toMatch(/preset/)
  })
})

describe('presetCoverage', () => {
  it('conta solo i gruppi realmente presenti (case-insensitive)', () => {
    const p = { name: 'X', set: 'S', groups: ['3ba', 'Assente', 'CBBE'], file: 'f' }
    expect(presetCoverage(p, ['3BA', 'CBBE', 'HIMBO'])).toBe(2)
  })
})

describe('chunkGroups', () => {
  it('rispetta il tetto caratteri della join', () => {
    const groups = Array.from({ length: 100 }, (_, i) => `Gruppo con nome piuttosto lungo numero ${i}`)
    const chunks = chunkGroups(groups, 500)
    expect(chunks.flat()).toEqual(groups)
    for (const c of chunks) expect(c.join(',').length).toBeLessThanOrEqual(500)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('un singolo gruppo oltre il tetto resta comunque da solo nel suo chunk', () => {
    expect(chunkGroups(['x'.repeat(600)], 500)).toEqual([['x'.repeat(600)]])
  })
})

describe('buildBodySlideArgs', () => {
  it('flag verificati: --groupbuild/--preset/--targetdir/--trimorphs', () => {
    expect(buildBodySlideArgs('Erin', ['A', 'B'], 'C:/out')).toEqual([
      '--groupbuild',
      'A,B',
      '--preset',
      'Erin',
      '--targetdir',
      'C:/out',
      '--trimorphs',
    ])
  })
})

describe('renderBodySlideConfig', () => {
  it('TargetGame SkyrimSE, path con backslash e trailing slash, entità escapate', () => {
    const xml = renderBodySlideConfig('C:/giochi/Skyrim & AE/Data')
    expect(xml).toContain('<TargetGame>4</TargetGame>')
    expect(xml).toContain('<GameDataPath>C:\\giochi\\Skyrim &amp; AE\\Data\\</GameDataPath>')
    expect(xml).toContain('<SkyrimSpecialEdition>C:\\giochi\\Skyrim &amp; AE\\Data\\</SkyrimSpecialEdition>')
    expect(xml).toContain('<BSATextureScan>false</BSATextureScan>')
  })
})

describe('checkPhysicsPrereqs', () => {
  it('riconosce corpo/CBPC/FSMP/scheletro dai nomi mod della collection', () => {
    const names = [
      'CBBE 3BA (3BBB)',
      'CBPC - Fomod installer - MAIN FILE',
      'FSMP 3.5.0',
      'XP32 Maximum Skeleton Special Extended',
    ]
    expect(checkPhysicsPrereqs(names)).toEqual({ body: true, cbpc: true, fsmp: true, skeleton: true })
  })

  it('assenze → false, e "Faster File Copy" NON conta come FSMP', () => {
    expect(checkPhysicsPrereqs(['Faster File Copy', 'SkyUI'])).toEqual({
      body: false,
      cbpc: false,
      fsmp: false,
      skeleton: false,
    })
  })
})
