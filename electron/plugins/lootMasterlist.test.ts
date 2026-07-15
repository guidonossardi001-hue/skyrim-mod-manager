import { describe, it, expect } from 'vitest'
import {
  parseMasterlistYaml,
  matchesPluginPattern,
  fetchMasterlistYaml,
  MasterlistFetchError,
  type HttpGetText,
} from './lootMasterlist'

const SAMPLE = `
groups:
  - name: &mainGroup Main Plugins
  - name: &fixesGroup Fixes
    after: [ *mainGroup ]
  - name: default
    after: [ *fixesGroup ]
  - name: &lowPriorityGroup Low Priority
    after: [ default ]

plugins:
  - name: 'Skyrim.esm'
    group: *mainGroup
  - name: 'USSEP.esp'
    group: *fixesGroup
    dirty:
      - crc: 0x17AB5E20
        util: '[SSEEdit v4.0.4](https://example.com)'
        itm: 334
        udr: 92
        nav: 3
  - name: 'SomePatch.esp'
    after: [ 'USSEP.esp', 'Base.esp' ]
  - name: 'Overlay.esp'
    group: *lowPriorityGroup
`

describe('parseMasterlistYaml', () => {
  it('estrae le regole after dirette con lo shape LootRule', () => {
    const r = parseMasterlistYaml(SAMPLE)
    expect(r.rules).toEqual([{ plugin: 'SomePatch.esp', after: ['USSEP.esp', 'Base.esp'] }])
  })

  it('calcola il rank dei gruppi via topo-sort sul grafo after (anchor/alias risolti da js-yaml)', () => {
    const r = parseMasterlistYaml(SAMPLE)
    const rankOf = (name: string) => r.groupRankByPattern.find((g) => g.pluginPattern === name)?.rank
    // Main Plugins -> Fixes -> default -> Low Priority: rank crescente in quest'ordine.
    expect(rankOf('Skyrim.esm')!).toBeLessThan(rankOf('USSEP.esp')!)
    expect(rankOf('USSEP.esp')!).toBeLessThan(rankOf('Overlay.esp')!)
  })

  it('estrae le entry dirty con crc esadecimale convertito a numero', () => {
    const r = parseMasterlistYaml(SAMPLE)
    expect(r.dirty).toEqual([
      { pluginPattern: 'USSEP.esp', crc: 0x17ab5e20, itm: 334, udr: 92, nav: 3, util: '[SSEEdit v4.0.4](https://example.com)' },
    ])
  })

  it('conta plugin e gruppi', () => {
    const r = parseMasterlistYaml(SAMPLE)
    expect(r.pluginCount).toBe(4)
    expect(r.groupCount).toBe(4)
  })

  it('YAML rotto o forma inattesa -> masterlist vuoto, mai un throw', () => {
    expect(parseMasterlistYaml('{ rotto')).toEqual({ rules: [], groupRankByPattern: [], dirty: [], pluginCount: 0, groupCount: 0 })
    expect(parseMasterlistYaml('- 1\n- 2')).toEqual({ rules: [], groupRankByPattern: [], dirty: [], pluginCount: 0, groupCount: 0 })
    expect(parseMasterlistYaml('')).toEqual({ rules: [], groupRankByPattern: [], dirty: [], pluginCount: 0, groupCount: 0 })
  })

  it('ciclo nel grafo gruppi -> rank per nome, mai un throw (dato community non fidato)', () => {
    // Riferimenti per nome letterale (non anchor/alias: YAML richiede l'anchor definito
    // PRIMA di ogni alias, quindi un ciclo reale non e' esprimibile con *a/*b).
    const cyc = `
groups:
  - name: A
    after: [ B ]
  - name: B
    after: [ A ]
plugins: []
`
    const r = parseMasterlistYaml(cyc)
    expect(r.groupCount).toBe(2)
  })
})

describe('matchesPluginPattern', () => {
  it('uguaglianza case-insensitive per un pattern letterale', () => {
    expect(matchesPluginPattern('USSEP.esp', 'ussep.esp')).toBe(true)
    expect(matchesPluginPattern('USSEP.esp', 'Other.esp')).toBe(false)
  })
  it('regex per pattern con metacaratteri (varianti di nome reali del masterlist)', () => {
    const pattern = 'Skyrim Project Optimization - (No Homes - )?Full( ESL)? Version\\.esm'
    expect(matchesPluginPattern(pattern, 'Skyrim Project Optimization - Full Version.esm')).toBe(true)
    expect(matchesPluginPattern(pattern, 'Skyrim Project Optimization - No Homes - Full ESL Version.esm')).toBe(true)
    expect(matchesPluginPattern(pattern, 'Totally Unrelated.esm')).toBe(false)
  })
  it('regex invalida o pattern vuoto -> nessun match, mai un throw', () => {
    expect(matchesPluginPattern('', 'X.esp')).toBe(false)
    expect(matchesPluginPattern('(unclosed', 'X.esp')).toBe(false)
  })
})

describe('fetchMasterlistYaml', () => {
  it('ritorna il corpo testuale su successo', async () => {
    const http: HttpGetText = async () => ({ status: 200, data: 'plugins: []' })
    expect(await fetchMasterlistYaml(http)).toBe('plugins: []')
  })
  it('MasterlistFetchError su risposta vuota o errore di rete', async () => {
    const empty: HttpGetText = async () => ({ status: 200, data: '' })
    await expect(fetchMasterlistYaml(empty)).rejects.toBeInstanceOf(MasterlistFetchError)
    const fail: HttpGetText = async () => {
      throw new Error('ECONNRESET')
    }
    await expect(fetchMasterlistYaml(fail)).rejects.toBeInstanceOf(MasterlistFetchError)
  })
  it('usa la URL custom quando fornita', async () => {
    let seen = ''
    const http: HttpGetText = async (url) => {
      seen = url
      return { status: 200, data: 'x' }
    }
    await fetchMasterlistYaml(http, { url: 'https://example.com/custom.yaml' })
    expect(seen).toBe('https://example.com/custom.yaml')
  })
})
