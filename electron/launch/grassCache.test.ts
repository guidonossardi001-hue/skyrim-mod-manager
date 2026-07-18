import { describe, it, expect } from 'vitest'
import { parseGrassCacheFilename, summarizeGrassCache, readIniValue, checkGrassPrereqs } from './grassCache'

describe('parseGrassCacheFilename', () => {
  it('formato base senza stagione', () => {
    const e = parseGrassCacheFilename('Tamrielx-0047y0038.cgid')
    expect(e).toEqual({ fileName: 'Tamrielx-0047y0038.cgid', worldspace: 'Tamriel', x: -47, y: 38, season: null })
  })

  it('varianti stagionali Seasons of Skyrim', () => {
    expect(parseGrassCacheFilename('Tamrielx0000y0000.WIN.cgid')?.season).toBe('WIN')
    expect(parseGrassCacheFilename('Tamrielx0000y0000.SUM.cgid')?.season).toBe('SUM')
  })

  it('worldspace custom (mod) e coordinate positive/negative', () => {
    const e = parseGrassCacheFilename('BlackreachRailroadx0012y-0099.cgid')
    expect(e?.worldspace).toBe('BlackreachRailroad')
    expect(e?.x).toBe(12)
    expect(e?.y).toBe(-99)
  })

  it('nome non conforme → null', () => {
    expect(parseGrassCacheFilename('readme.txt')).toBeNull()
    expect(parseGrassCacheFilename('Tamriel.cgid')).toBeNull()
  })
})

describe('summarizeGrassCache', () => {
  it('raggruppa per worldspace e conta i non-parsabili', () => {
    const s = summarizeGrassCache(['Tamrielx0000y0000.cgid', 'Tamrielx0001y0000.cgid', 'Blackreachx0000y0000.cgid', 'notes.txt'])
    expect(s.totalFiles).toBe(4)
    expect(s.parsedCount).toBe(3)
    expect(s.unparsedCount).toBe(1)
    expect(s.byWorldspace).toEqual({ Tamriel: 2, Blackreach: 1 })
  })
})

describe('readIniValue', () => {
  const ini = `[General]\nsLanguage=ENGLISH\n\n[Grass]\nbAllowLoadGrass=1\niMinGrassSize=40 ; commento\n\n[Display]\nbAllowCreateGrass=0\n`

  it('legge una chiave nella sezione corretta', () => {
    expect(readIniValue(ini, 'Grass', 'bAllowLoadGrass')).toBe('1')
    expect(readIniValue(ini, 'Grass', 'iMinGrassSize')).toBe('40')
  })

  it('non confonde chiavi omonime in sezioni diverse', () => {
    expect(readIniValue(ini, 'Display', 'bAllowLoadGrass')).toBeNull()
  })

  it('sezione o chiave assenti → null', () => {
    expect(readIniValue(ini, 'Nope', 'x')).toBeNull()
    expect(readIniValue(ini, 'Grass', 'nope')).toBeNull()
  })
})

describe('checkGrassPrereqs', () => {
  it('tutto a posto → ready', () => {
    const ini = '[Grass]\nbAllowLoadGrass=1\nbGenerateGrassDataFiles=1\n'
    const r = checkGrassPrereqs(ini, true)
    expect(r.ready).toBe(true)
    expect(r.issues).toEqual([])
    expect(r.bGenerateGrassDataFiles).toBe(true)
  })

  it('bAllowLoadGrass=0 e marker assente → issues', () => {
    const ini = '[Grass]\nbAllowLoadGrass=0\n'
    const r = checkGrassPrereqs(ini, false)
    expect(r.ready).toBe(false)
    expect(r.issues).toHaveLength(2)
  })

  it('chiavi assenti → null, non false (non inventare un default)', () => {
    const r = checkGrassPrereqs('[General]\nsLanguage=ENGLISH\n', true)
    expect(r.bAllowLoadGrass).toBeNull()
    expect(r.bGenerateGrassDataFiles).toBeNull()
  })
})
