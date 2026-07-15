import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseMasterlist, loadMasterlist } from './masterlist'

describe('parseMasterlist', () => {
  it('estrae le regole valide e scarta le voci malformate', () => {
    const raw = JSON.stringify({
      rules: [
        { plugin: 'Patch.esp', after: ['Base.esp', 'Lib.esp'] },
        { plugin: '', after: ['X.esp'] }, // plugin vuoto → scartata
        { plugin: 'NoAfter.esp' }, // after assente → scartata
        { plugin: 'Empty.esp', after: [] }, // after vuoto → scartata
        { plugin: 'Mixed.esp', after: ['Ok.esp', 42, ''] }, // ripulita ai soli string validi
      ],
    })
    expect(parseMasterlist(raw)).toEqual([
      { plugin: 'Patch.esp', after: ['Base.esp', 'Lib.esp'] },
      { plugin: 'Mixed.esp', after: ['Ok.esp'] },
    ])
  })
  it('JSON rotto o forma inattesa → zero regole, mai throw', () => {
    expect(parseMasterlist('{ rotto')).toEqual([])
    expect(parseMasterlist('null')).toEqual([])
    expect(parseMasterlist('{"rules": "no"}')).toEqual([])
  })
})

describe('loadMasterlist', () => {
  it('file assente o path nullo → []; file valido → regole', () => {
    expect(loadMasterlist(null)).toEqual([])
    expect(loadMasterlist('X:/inesistente/masterlist.json')).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'ml-'))
    try {
      const p = join(dir, 'masterlist.json')
      writeFileSync(p, JSON.stringify({ rules: [{ plugin: 'A.esp', after: ['B.esp'] }] }))
      expect(loadMasterlist(p)).toEqual([{ plugin: 'A.esp', after: ['B.esp'] }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
