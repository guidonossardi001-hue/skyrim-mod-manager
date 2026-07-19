import { describe, it, expect } from 'vitest'
import { buildXeditConflictPlan, objectIndexFromFormKey } from './xeditLaunch'

describe('buildXeditConflictPlan', () => {
  const base = {
    gameFlag: 'SSE',
    dataPath: 'C:/Game/Data',
    pluginsTxtPath: 'C:/Temp/smm-xedit-conflict-plugins.txt',
    formKey: 'skyrim.esm|012eb7',
  }

  it('args nel formato QAC-verificato: -SSE -autoload -D: -P:', () => {
    const plan = buildXeditConflictPlan({ ...base, participants: ['Skyrim.esm', 'ModA.esp'], edid: null })
    expect(plan.args).toEqual([
      '-SSE',
      '-autoload',
      '-D:C:/Game/Data',
      '-P:C:/Temp/smm-xedit-conflict-plugins.txt',
    ])
  })

  it('plugins.txt: una riga *Nome per partecipante, CRLF, dedup case-insensitive in ordine', () => {
    const plan = buildXeditConflictPlan({
      ...base,
      participants: ['Skyrim.esm', 'ModA.esp', 'moda.esp', 'ModB.esp'],
      edid: null,
    })
    expect(plan.pluginsTxtContent).toBe('*Skyrim.esm\r\n*ModA.esp\r\n*ModB.esp\r\n')
  })

  it('hint clipboard: EDID se presente, altrimenti object index esadecimale', () => {
    expect(
      buildXeditConflictPlan({ ...base, participants: ['A.esp'], edid: 'IronSword' }).clipboardHint,
    ).toBe('IronSword')
    expect(buildXeditConflictPlan({ ...base, participants: ['A.esp'], edid: null }).clipboardHint).toBe(
      '012EB7',
    )
  })
})

describe('objectIndexFromFormKey', () => {
  it('estrae e normalizza a 6 cifre maiuscole; forme invalide → stringa vuota', () => {
    expect(objectIndexFromFormKey('skyrim.esm|012eb7')).toBe('012EB7')
    expect(objectIndexFromFormKey('a.esp|d63')).toBe('000D63')
    expect(objectIndexFromFormKey('senza-pipe')).toBe('')
    expect(objectIndexFromFormKey('a.esp|nothex!')).toBe('')
  })
})
