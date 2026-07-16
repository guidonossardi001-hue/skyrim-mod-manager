import { describe, it, expect } from 'vitest'
import { deflateSync } from 'zlib'
import { join } from 'path'
import { findLatestSave, readEnabledPlugins, diagnoseSave, runSaveDoctor, type SaveDoctorIo } from './saveDoctor'
import type { EssInfo } from './essParser'

// Fixture .ess minima (zlib per semplicità) — riusa il layout del parser reale.
function wstr(s: string): Buffer {
  const b = Buffer.from(s, 'latin1')
  const len = Buffer.alloc(2)
  len.writeUInt16LE(b.length)
  return Buffer.concat([len, b])
}
function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v)
  return b
}
function buildEss(plugins: string[]): Buffer {
  const pluginBlock = Buffer.concat([Buffer.from([plugins.length]), ...plugins.map(wstr)])
  const body = Buffer.concat([Buffer.from([74]), u32(pluginBlock.length), pluginBlock])
  const header = Buffer.concat([
    u32(12),
    u32(1),
    wstr('Hero'),
    u32(10),
    wstr('Riverwood'),
    wstr('1 giorno'),
    wstr('Nord'),
    u16(0),
    Buffer.alloc(16),
    u32(0),
    u32(0),
    u16(1), // zlib
  ])
  const compressed = deflateSync(body)
  return Buffer.concat([
    Buffer.from('TESV_SAVEGAME', 'latin1'),
    u32(header.length),
    header,
    u32(body.length),
    u32(compressed.length),
    compressed,
  ])
}

const SAVES = 'C:\\docs\\Saves'
const PLUGINS_TXT = 'C:\\local\\plugins.txt'
const DATA = 'C:\\game\\Data'

function fakeIo(opts: {
  saves?: { name: string; mtimeMs: number }[]
  saveBuf?: Buffer
  pluginsTxt?: string
  dataFiles?: string[]
}): SaveDoctorIo {
  return {
    exists: (p) => {
      if (p === SAVES) return (opts.saves ?? []).length > 0 || opts.saves !== undefined
      if (p === PLUGINS_TXT) return opts.pluginsTxt !== undefined
      if (p === DATA) return opts.dataFiles !== undefined
      return false
    },
    listDir: (p) => {
      if (p === SAVES) return opts.saves ?? []
      if (p === DATA) return (opts.dataFiles ?? []).map((name) => ({ name, mtimeMs: 0 }))
      return []
    },
    readFileBuf: () => opts.saveBuf ?? Buffer.alloc(0),
    readFileText: () => opts.pluginsTxt ?? '',
  }
}

describe('findLatestSave', () => {
  it('sceglie il .ess più recente per mtime, ignora altri file', () => {
    const io = fakeIo({
      saves: [
        { name: 'old.ess', mtimeMs: 100 },
        { name: 'new.ess', mtimeMs: 900 },
        { name: 'new.skse', mtimeMs: 999 },
      ],
    })
    expect(findLatestSave(SAVES, io)).toBe(join(SAVES, 'new.ess'))
  })
  it('cartella assente o vuota → null', () => {
    expect(findLatestSave(SAVES, fakeIo({}))).toBeNull()
    expect(findLatestSave(SAVES, fakeIo({ saves: [] }))).toBeNull()
  })
})

describe('readEnabledPlugins', () => {
  it('legge solo le righe abilitate (*)', () => {
    const io = fakeIo({ pluginsTxt: '# commento\n*Alpha.esp\nDisattivo.esp\n*Beta.esl\n' })
    expect(readEnabledPlugins(PLUGINS_TXT, io)).toEqual(['Alpha.esp', 'Beta.esl'])
  })
  it('path nullo o file assente → []', () => {
    expect(readEnabledPlugins(null, fakeIo({}))).toEqual([])
    expect(readEnabledPlugins(PLUGINS_TXT, fakeIo({}))).toEqual([])
  })
})

describe('diagnoseSave', () => {
  const ess = { plugins: ['Skyrim.esm', 'CoolMod.esp'], lightPlugins: ['Tiny.esl'] } as EssInfo
  it('copertura da plugins.txt O da file su disco (case-insensitive)', () => {
    const r = diagnoseSave(ess, ['coolmod.esp'], ['SKYRIM.ESM', 'tiny.esl'])
    expect(r.missingCount).toBe(0)
  })
  it('plugin del save assente ovunque → missing', () => {
    const r = diagnoseSave(ess, ['CoolMod.esp'], ['Skyrim.esm'])
    expect(r.missing).toEqual(['Tiny.esl'])
    expect(r.missingCount).toBe(1)
  })
})

describe('runSaveDoctor', () => {
  const env = { savesDir: SAVES, systemPluginsTxt: PLUGINS_TXT, gameDataDir: DATA }

  it('diagnosi completa: save che richiede un plugin rimosso', () => {
    const io = fakeIo({
      saves: [{ name: 'hero.ess', mtimeMs: 1 }],
      saveBuf: buildEss(['Skyrim.esm', 'RimossaMod.esp']),
      pluginsTxt: '*AltraMod.esp\n',
      dataFiles: ['Skyrim.esm'],
    })
    const r = runSaveDoctor(env, io)
    expect(r.checked).toBe(true)
    expect(r.saveName).toBe('hero.ess')
    expect(r.playerName).toBe('Hero')
    expect(r.missingPlugins).toEqual(['RimossaMod.esp'])
    expect(r.totalSavePlugins).toBe(2)
  })

  it('nessun save → checked:false (mai warning spurio)', () => {
    expect(runSaveDoctor(env, fakeIo({ saves: [] })).checked).toBe(false)
  })

  it('save non parsabile → checked:false', () => {
    const io = fakeIo({ saves: [{ name: 'x.ess', mtimeMs: 1 }], saveBuf: Buffer.alloc(64, 7) })
    expect(runSaveDoctor(env, io).checked).toBe(false)
  })

  it('zero fonti di verità sul load order → checked:false invece di "manca tutto"', () => {
    const io = fakeIo({
      saves: [{ name: 'x.ess', mtimeMs: 1 }],
      saveBuf: buildEss(['Skyrim.esm']),
    })
    expect(runSaveDoctor(env, io).checked).toBe(false)
  })
})
