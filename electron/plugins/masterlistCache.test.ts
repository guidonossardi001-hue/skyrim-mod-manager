import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadMasterlistCache, refreshMasterlistCache, mergeMasterlists } from './masterlistCache'
import type { HttpGetText } from './lootMasterlist'

describe('loadMasterlistCache', () => {
  it('null per path assente o file inesistente', () => {
    expect(loadMasterlistCache(null)).toBeNull()
    expect(loadMasterlistCache('X:/non/esiste/cache.json')).toBeNull()
  })
  it('null su JSON corrotto o forma inattesa (fail-soft)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlc-'))
    try {
      const p = join(dir, 'cache.json')
      writeFileSync(p, '{ rotto')
      expect(loadMasterlistCache(p)).toBeNull()
      writeFileSync(p, JSON.stringify({ rules: 'non un array' }))
      expect(loadMasterlistCache(p)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('legge una cache valida con default sicuri sui campi opzionali', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlc-'))
    try {
      const p = join(dir, 'cache.json')
      writeFileSync(p, JSON.stringify({ rules: [{ plugin: 'A.esp', after: ['B.esp'] }], dirty: [], groupRankByPattern: [] }))
      const c = loadMasterlistCache(p)
      expect(c?.rules).toEqual([{ plugin: 'A.esp', after: ['B.esp'] }])
      expect(c?.pluginCount).toBe(0)
      expect(c?.fetchedAt).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshMasterlistCache', () => {
  it('scarica, parse e scrive la cache su disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlc-'))
    try {
      const p = join(dir, 'sub', 'cache.json') // sottocartella inesistente: deve crearla
      const http: HttpGetText = async () => ({
        status: 200,
        data: "plugins:\n  - name: 'A.esp'\n    after: [ 'B.esp' ]\n",
      })
      const cache = await refreshMasterlistCache(http, p, { nowIso: '2026-07-15T00:00:00.000Z' })
      expect(cache.rules).toEqual([{ plugin: 'A.esp', after: ['B.esp'] }])
      expect(cache.fetchedAt).toBe('2026-07-15T00:00:00.000Z')
      const reloaded = loadMasterlistCache(p)
      expect(reloaded?.rules).toEqual(cache.rules)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('propaga l’errore su fetch fallita senza toccare il disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlc-'))
    try {
      const p = join(dir, 'cache.json')
      const http: HttpGetText = async () => {
        throw new Error('offline')
      }
      await expect(refreshMasterlistCache(http, p, { nowIso: '2026-07-15T00:00:00.000Z' })).rejects.toThrow()
      expect(loadMasterlistCache(p)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeMasterlists', () => {
  it('concatena rules/groupRankByPattern/dirty e somma i conteggi', () => {
    const a = { rules: [{ plugin: 'A.esp', after: ['B.esp'] }], groupRankByPattern: [{ pluginPattern: 'A.esp', rank: 0 }], dirty: [], pluginCount: 1, groupCount: 1 }
    const b = { rules: [{ plugin: 'C.esp', after: ['D.esp'] }], groupRankByPattern: [], dirty: [{ pluginPattern: 'X.esp', crc: 1, itm: 1, udr: 1, nav: 0, util: 'u' }], pluginCount: 1, groupCount: 0 }
    const m = mergeMasterlists(a, b)
    expect(m.rules).toHaveLength(2)
    expect(m.dirty).toHaveLength(1)
    expect(m.pluginCount).toBe(2)
    expect(m.groupCount).toBe(1)
  })
  it('tollera null su entrambi i lati', () => {
    expect(mergeMasterlists(null, null)).toEqual({ rules: [], groupRankByPattern: [], dirty: [], pluginCount: 0, groupCount: 0 })
  })
})
