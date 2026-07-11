import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseGamePluginsTxt,
  scanPluginFiles,
  mergeLoadOrder,
  getLoadOrder,
  serializePluginsTxt,
  saveLoadOrder,
} from './pluginManager'
import type { LoadOrderEntry } from '../src/types'

const E = (name: string, active: boolean, index: number): LoadOrderEntry => ({ name, active, index })

describe('parseGamePluginsTxt', () => {
  it('reads active flag from the leading *, preserves order, skips comments/blanks', () => {
    const txt = ['# header', '', '*Enabled.esp', 'Disabled.esp', '  *Spaced.esm  '].join('\n')
    expect(parseGamePluginsTxt(txt)).toEqual([
      { name: 'Enabled.esp', active: true },
      { name: 'Disabled.esp', active: false },
      { name: 'Spaced.esm', active: true },
    ])
  })

  it('is BOM- and CRLF-tolerant', () => {
    const txt = '﻿*A.esp\r\nB.esp\r\n'
    expect(parseGamePluginsTxt(txt)).toEqual([
      { name: 'A.esp', active: true },
      { name: 'B.esp', active: false },
    ])
  })

  it('returns [] for empty content', () => {
    expect(parseGamePluginsTxt('')).toEqual([])
  })
})

describe('mergeLoadOrder', () => {
  it('orders base masters first (active), then plugins.txt order, then disk-only inactive', () => {
    const txt = [
      { name: 'SkyUI_SE.esp', active: true },
      { name: 'Ordinator.esp', active: false },
    ]
    const disk = ['Skyrim.esm', 'Update.esm', 'SkyUI_SE.esp', 'Ordinator.esp', 'Orphan.esp']
    const lo = mergeLoadOrder(txt, disk)
    expect(lo).toEqual([
      { name: 'Skyrim.esm', active: true, index: 0 },
      { name: 'Update.esm', active: true, index: 1 },
      { name: 'SkyUI_SE.esp', active: true, index: 2 },
      { name: 'Ordinator.esp', active: false, index: 3 },
      { name: 'Orphan.esp', active: false, index: 4 }, // on disk, absent from plugins.txt
    ])
  })

  it('drops stale plugins.txt entries not present on disk', () => {
    const txt = [{ name: 'Ghost.esp', active: true }]
    const lo = mergeLoadOrder(txt, ['Real.esp'])
    expect(lo.map((e) => e.name)).toEqual(['Real.esp'])
    expect(lo[0].active).toBe(false)
  })

  it('forces base masters active even if plugins.txt marks them off, and matches disk casing', () => {
    const txt = [{ name: 'skyrim.esm', active: false }]
    const lo = mergeLoadOrder(txt, ['Skyrim.esm'])
    expect(lo).toEqual([{ name: 'Skyrim.esm', active: true, index: 0 }])
  })
})

describe('scanPluginFiles + getLoadOrder (IO)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugmgr-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('scans only .esp/.esm/.esl, sorted, ignoring other files', () => {
    const data = join(dir, 'Data')
    mkdirSync(data)
    for (const f of ['b.esp', 'A.esm', 'c.esl', 'texture.dds', 'readme.txt']) {
      writeFileSync(join(data, f), '')
    }
    expect(scanPluginFiles(data)).toEqual(['A.esm', 'b.esp', 'c.esl'])
  })

  it('returns [] when the Data dir does not exist (no throw)', () => {
    expect(scanPluginFiles(join(dir, 'nope'))).toEqual([])
  })

  it('getLoadOrder merges a real plugins.txt with the Data scan', () => {
    const data = join(dir, 'Data')
    mkdirSync(data)
    for (const f of ['Skyrim.esm', 'SkyUI_SE.esp', 'Extra.esp']) writeFileSync(join(data, f), '')
    const txtPath = join(dir, 'plugins.txt')
    writeFileSync(txtPath, '*SkyUI_SE.esp\n')
    const lo = getLoadOrder({ dataDir: data, pluginsTxtPath: txtPath })
    expect(lo).toEqual([
      { name: 'Skyrim.esm', active: true, index: 0 },
      { name: 'SkyUI_SE.esp', active: true, index: 1 },
      { name: 'Extra.esp', active: false, index: 2 },
    ])
  })

  it('getLoadOrder degrades to disk-only when plugins.txt is missing (Skyrim writes it on first run)', () => {
    const data = join(dir, 'Data')
    mkdirSync(data)
    for (const f of ['Skyrim.esm', 'Mod.esp']) writeFileSync(join(data, f), '')
    const lo = getLoadOrder({ dataDir: data, pluginsTxtPath: join(dir, 'absent.txt') })
    expect(lo).toEqual([
      { name: 'Skyrim.esm', active: true, index: 0 },
      { name: 'Mod.esp', active: false, index: 1 },
    ])
  })
})

describe('serializePluginsTxt', () => {
  it('prefixes active plugins with *, inactive with the bare name, in index order, CRLF-terminated', () => {
    const out = serializePluginsTxt([E('B.esp', false, 1), E('A.esp', true, 0)])
    expect(out).toBe('*A.esp\r\nB.esp\r\n')
  })

  it('omits the BOM by default and prepends it only when requested', () => {
    expect(serializePluginsTxt([E('A.esp', true, 0)])).toBe('*A.esp\r\n')
    expect(serializePluginsTxt([E('A.esp', true, 0)], { bom: true })).toBe('﻿*A.esp\r\n')
  })

  it('strips stray line breaks from names and drops empty ones (format cannot be corrupted)', () => {
    const out = serializePluginsTxt([E('Ev\nil.esp', true, 0), E('   ', false, 1)])
    expect(out).toBe('*Evil.esp\r\n')
  })

  it('returns an empty string for no entries', () => {
    expect(serializePluginsTxt([])).toBe('')
  })
})

describe('saveLoadOrder (IO)', () => {
  let dir: string
  let txtPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugsave-'))
    txtPath = join(dir, 'plugins.txt')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes plugins.txt with the Skyrim format and reports the line count', () => {
    const r = saveLoadOrder([E('Skyrim.esm', true, 0), E('Mod.esp', false, 1)], txtPath)
    expect(r.success).toBe(true)
    expect(r.written).toBe(2)
    expect(readFileSync(txtPath, 'utf8')).toBe('*Skyrim.esm\r\nMod.esp\r\n')
  })

  it('backs up the existing file to .bak, overwriting any stale backup', () => {
    writeFileSync(txtPath, 'OLD-CONTENT\r\n')
    writeFileSync(txtPath + '.bak', 'STALE-BACKUP\r\n') // must be overwritten
    const r = saveLoadOrder([E('New.esp', true, 0)], txtPath)
    expect(r.success).toBe(true)
    expect(r.backupPath).toBe(txtPath + '.bak')
    expect(readFileSync(txtPath + '.bak', 'utf8')).toBe('OLD-CONTENT\r\n') // == pre-write plugins.txt
    expect(readFileSync(txtPath, 'utf8')).toBe('*New.esp\r\n')
  })

  it('skips the backup when there is no existing plugins.txt (fresh write)', () => {
    const r = saveLoadOrder([E('Mod.esp', true, 0)], txtPath)
    expect(r.success).toBe(true)
    expect(r.backupPath).toBeNull()
    expect(existsSync(txtPath + '.bak')).toBe(false)
  })

  it('leaves no .tmp residue on success (atomic write)', () => {
    saveLoadOrder([E('Mod.esp', true, 0)], txtPath)
    expect(existsSync(txtPath + '.tmp')).toBe(false)
  })

  it('returns success:false with a clear message on an unwritable path — never throws', () => {
    const bad = join(dir, 'does-not-exist', 'plugins.txt')
    const r = saveLoadOrder([E('Mod.esp', true, 0)], bad)
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
    expect(existsSync(bad)).toBe(false)
  })

  it('rejects a non-array without throwing', () => {
    const r = saveLoadOrder(null as unknown as LoadOrderEntry[], txtPath)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/array/i)
  })

  it('round-trips: getLoadOrder after saveLoadOrder reproduces the saved order', () => {
    const data = join(dir, 'Data')
    mkdirSync(data)
    for (const f of ['Skyrim.esm', 'SkyUI_SE.esp', 'Extra.esp']) writeFileSync(join(data, f), '')
    const saved: LoadOrderEntry[] = [
      E('Skyrim.esm', true, 0),
      E('SkyUI_SE.esp', true, 1),
      E('Extra.esp', false, 2),
    ]
    const w = saveLoadOrder(saved, txtPath)
    expect(w.success).toBe(true)
    expect(getLoadOrder({ dataDir: data, pluginsTxtPath: txtPath })).toEqual(saved)
  })
})
