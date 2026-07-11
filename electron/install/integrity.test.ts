import { describe, it, expect } from 'vitest'
import {
  normalizeAlgo,
  hashesEqual,
  pickExpectedHash,
  md5SearchConfirms,
  decideIntegrity,
} from './integrity'

describe('normalizeAlgo', () => {
  it('accepts md5/sha256 (case-insensitive), rejects the rest', () => {
    expect(normalizeAlgo('md5')).toBe('md5')
    expect(normalizeAlgo('SHA256')).toBe('sha256')
    expect(normalizeAlgo('sha1')).toBeNull()
    expect(normalizeAlgo(null)).toBeNull()
    expect(normalizeAlgo(undefined)).toBeNull()
  })
})

describe('hashesEqual', () => {
  it('is case-insensitive and requires both present', () => {
    expect(hashesEqual('ABCD', 'abcd')).toBe(true)
    expect(hashesEqual('ab', 'ac')).toBe(false)
    expect(hashesEqual('', 'abcd')).toBe(false)
    expect(hashesEqual('abcd', null)).toBe(false)
  })
})

describe('pickExpectedHash (layering)', () => {
  it('prefers the download column, carrying its declared algo', () => {
    expect(pickExpectedHash({ downloadColumn: { value: 'aa', algo: 'md5' }, deltaSha256: 'bb' })).toEqual({
      value: 'aa',
      algo: 'md5',
    })
  })
  it('defaults an unknown/missing column algo to sha256', () => {
    expect(pickExpectedHash({ downloadColumn: { value: 'aa', algo: 'weird' } })).toEqual({
      value: 'aa',
      algo: 'sha256',
    })
  })
  it('falls back to the delta sha256 when no column hash', () => {
    expect(pickExpectedHash({ downloadColumn: null, deltaSha256: 'bb' })).toEqual({ value: 'bb', algo: 'sha256' })
  })
  it('returns null when nothing trusted is available', () => {
    expect(pickExpectedHash({})).toBeNull()
    expect(pickExpectedHash({ downloadColumn: { value: null }, deltaSha256: null })).toBeNull()
  })
})

describe('md5SearchConfirms', () => {
  const resp = [{ mod: { mod_id: 2347 }, file_details: { file_id: 12345, md5: 'abc' } }]
  it('confirms when a result maps to the requested mod AND file', () => {
    expect(md5SearchConfirms(resp, { modId: 2347, fileId: 12345 })).toBe(true)
  })
  it('confirms on mod match alone when no specific file is requested', () => {
    expect(md5SearchConfirms(resp, { modId: 2347, fileId: null })).toBe(true)
  })
  it('rejects a mod mismatch (attacker file for a different mod)', () => {
    expect(md5SearchConfirms(resp, { modId: 9999, fileId: 12345 })).toBe(false)
  })
  it('rejects a file mismatch within the right mod', () => {
    expect(md5SearchConfirms(resp, { modId: 2347, fileId: 99999 })).toBe(false)
  })
  it('rejects a non-array / empty response', () => {
    expect(md5SearchConfirms(null, { modId: 1, fileId: 1 })).toBe(false)
    expect(md5SearchConfirms([], { modId: 1, fileId: 1 })).toBe(false)
    expect(md5SearchConfirms({ error: 'not found' }, { modId: 1, fileId: 1 })).toBe(false)
  })
})

describe('decideIntegrity (fail-closed gate)', () => {
  it('passes on a matching expected hash (right algo)', () => {
    const d = decideIntegrity({ expected: { value: 'ABCD', algo: 'sha256' }, computed: { sha256: 'abcd' } })
    expect(d).toEqual({ ok: true, verifiedBy: 'expected-hash' })
  })
  it('picks the md5 digest when the expected algo is md5', () => {
    const d = decideIntegrity({ expected: { value: 'ff', algo: 'md5' }, computed: { md5: 'FF', sha256: 'zz' } })
    expect(d.ok).toBe(true)
  })
  it('fails on a hash mismatch with a descriptive reason', () => {
    const d = decideIntegrity({ expected: { value: 'aaaaaaaaaaaaaaaa', algo: 'sha256' }, computed: { sha256: 'bbbbbbbbbbbbbbbb' } })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain('non corrisponde')
  })
  it('fails when the required digest was not computed', () => {
    const d = decideIntegrity({ expected: { value: 'aa', algo: 'md5' }, computed: { sha256: 'aa' } })
    expect(d.ok).toBe(false)
  })
  it('passes with no expected hash ONLY when md5_search confirms', () => {
    expect(decideIntegrity({ expected: null, computed: { md5: 'x' }, md5SearchConfirmed: true })).toEqual({
      ok: true,
      verifiedBy: 'md5-search',
    })
  })
  it('fails closed with no expected hash and no md5_search confirmation', () => {
    expect(decideIntegrity({ expected: null, computed: { md5: 'x' }, md5SearchConfirmed: false }).ok).toBe(false)
    expect(decideIntegrity({ expected: null, computed: { md5: 'x' }, md5SearchConfirmed: null }).ok).toBe(false)
    expect(decideIntegrity({ expected: null, computed: {} }).ok).toBe(false)
  })
})
