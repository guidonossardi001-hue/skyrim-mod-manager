import { describe, it, expect } from 'vitest'
import { buildXLODGenArgs, xlodgenOutputDir, XLODGEN_OUTPUT_DIR } from './xlodgen'

describe('buildXLODGenArgs', () => {
  it('sempre -sse (game mode) + -o (output isolato), anche senza gli altri path', () => {
    expect(buildXLODGenArgs({ outputDir: 'C:/out' })).toEqual(['-sse', '-o:C:/out'])
  })

  it('aggiunge -d/-p/-m quando presenti, nell’ordine atteso', () => {
    expect(
      buildXLODGenArgs({
        outputDir: 'C:/out',
        dataDir: 'C:/game/Data',
        pluginsTxt: 'C:/plugins.txt',
        iniDir: 'C:/Documents/My Games/Skyrim Special Edition',
      }),
    ).toEqual([
      '-sse',
      '-o:C:/out',
      '-d:C:/game/Data',
      '-p:C:/plugins.txt',
      '-m:C:/Documents/My Games/Skyrim Special Edition',
    ])
  })

  it('null/undefined → arg omesso (mai un flag vuoto che romperebbe il parsing di xLODGen)', () => {
    expect(buildXLODGenArgs({ outputDir: 'C:/out', dataDir: null, pluginsTxt: undefined, iniDir: null })).toEqual([
      '-sse',
      '-o:C:/out',
    ])
  })

  it('omette solo i null, tiene i presenti (path parziali)', () => {
    expect(buildXLODGenArgs({ outputDir: 'C:/out', dataDir: 'C:/Data', pluginsTxt: null })).toEqual([
      '-sse',
      '-o:C:/out',
      '-d:C:/Data',
    ])
  })
})

describe('xlodgenOutputDir', () => {
  it('cartella output sotto la radice mods', () => {
    expect(xlodgenOutputDir('C:/mods')).toContain(XLODGEN_OUTPUT_DIR)
  })
})
