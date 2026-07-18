import { describe, it, expect } from 'vitest'
import { buildQacArgs, isProtectedMaster, qacLogFileNames, parseQacLog, classifyQacRun } from './qacRunner'

describe('buildQacArgs', () => {
  it('ordine e formato esatti (plugin come argomento posizionale nudo)', () => {
    const args = buildQacArgs({
      gameFlag: 'SSE',
      dataPath: 'C:\\Game\\Data',
      pluginsTxtPath: 'C:\\tmp\\plugins.txt',
      pluginName: 'Patch.esp',
    })
    expect(args).toEqual(['-SSE', '-autoload', '-autoexit', '-QAC', '-D:C:\\Game\\Data', '-P:C:\\tmp\\plugins.txt', 'Patch.esp'])
  })
})

describe('isProtectedMaster', () => {
  it('rifiuta i master ufficiali (bug storico xEdit <4.0.3)', () => {
    expect(isProtectedMaster('Skyrim.esm')).toBe(true)
    expect(isProtectedMaster('DAWNGUARD.ESM')).toBe(true)
    expect(isProtectedMaster('MyPatch.esp')).toBe(false)
  })
})

describe('qacLogFileNames', () => {
  it('deriva i nomi dal prefisso gioco, non dal nome exe', () => {
    expect(qacLogFileNames('SSE')).toEqual({ log: 'SSEEdit_log.txt', exception: 'SSEEditException.log' })
  })
})

describe('parseQacLog', () => {
  it('estrae le tre categorie di righe', () => {
    const text = 'Undeleting: [REFR:0001] foo\nRemoving: [ARMO:0002] bar\nSkipping: [NAVM:0003] baz\n'
    const s = parseQacLog(text)
    expect(s.undeleted).toHaveLength(1)
    expect(s.removed).toHaveLength(1)
    expect(s.skippedNavmeshes).toHaveLength(1)
    expect(s.nothingToClean).toBe(false)
  })

  it('nessuna riga corrispondente → nothingToClean', () => {
    expect(parseQacLog('Loading plugin...\nDone.\n').nothingToClean).toBe(true)
  })
})

describe('classifyQacRun', () => {
  it('timeout ha priorità su tutto', () => {
    expect(classifyQacRun({ logText: 'Removing: x', exceptionLogExists: false, timedOut: true }).verdict).toBe('timeout')
  })

  it('exception log presente → crashed', () => {
    expect(classifyQacRun({ logText: null, exceptionLogExists: true, timedOut: false }).verdict).toBe('crashed')
  })

  it('nessun log e nessuna exception → crashed (log mai scritto)', () => {
    expect(classifyQacRun({ logText: null, exceptionLogExists: false, timedOut: false }).verdict).toBe('crashed')
  })

  it('log presente senza righe di pulizia → nothing-to-clean', () => {
    const r = classifyQacRun({ logText: 'Loading...\n', exceptionLogExists: false, timedOut: false })
    expect(r.verdict).toBe('nothing-to-clean')
  })

  it('log con righe Removing → cleaned con riepilogo', () => {
    const r = classifyQacRun({ logText: 'Removing: [ARMO:0002] bar\n', exceptionLogExists: false, timedOut: false })
    expect(r.verdict).toBe('cleaned')
    expect(r.summary).toMatch(/1 record ITM rimossi/)
  })
})
