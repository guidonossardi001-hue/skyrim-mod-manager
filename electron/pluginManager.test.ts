import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseGamePluginsTxt,
  scanPluginFiles,
  mergeLoadOrder,
  getLoadOrder,
} from './pluginManager'

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
