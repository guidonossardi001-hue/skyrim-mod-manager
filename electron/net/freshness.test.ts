import { describe, it, expect } from 'vitest'
import {
  parseTimestamp,
  monotonicNow,
  effectiveBaseline,
  checkFreshness,
  type FreshnessBaseline,
} from './freshness'

describe('parseTimestamp', () => {
  it('parses an ISO timestamp, rejects junk', () => {
    expect(parseTimestamp('2026-06-24T00:00:00Z')).toBe(Date.parse('2026-06-24T00:00:00Z'))
    expect(parseTimestamp('not a date')).toBeNull()
    expect(parseTimestamp(null)).toBeNull()
    expect(parseTimestamp('')).toBeNull()
  })
})

describe('monotonicNow (clock-rollback resistance)', () => {
  const LAST = '2026-07-10T00:00:00Z'
  const lastMs = Date.parse(LAST)
  it('uses the wall clock when it is ahead of the last accepted release', () => {
    const wall = lastMs + 5 * 86400_000
    expect(monotonicNow(wall, LAST)).toBe(wall)
  })
  it('floors to the last accepted published_at when the clock is rolled back', () => {
    const rolledBack = lastMs - 30 * 86400_000
    expect(monotonicNow(rolledBack, LAST)).toBe(lastMs)
  })
  it('falls back to the wall clock when there is no baseline', () => {
    expect(monotonicNow(123456, null)).toBe(123456)
  })
})

describe('effectiveBaseline (fold the build-time floor)', () => {
  it('a fresh install inherits the shipped floor', () => {
    const b = effectiveBaseline({ lastCounter: 0, lastPublishedAt: null }, { counter: 2, publishedAt: '2026-06-24T00:00:00Z' })
    expect(b).toEqual({ lastCounter: 2, lastPublishedAt: '2026-06-24T00:00:00Z' })
  })
  it('an up-to-date install keeps its own higher values', () => {
    const b = effectiveBaseline({ lastCounter: 9, lastPublishedAt: '2026-07-01T00:00:00Z' }, { counter: 2, publishedAt: '2026-06-24T00:00:00Z' })
    expect(b).toEqual({ lastCounter: 9, lastPublishedAt: '2026-07-01T00:00:00Z' })
  })
  it('takes the max per axis independently', () => {
    const b = effectiveBaseline({ lastCounter: 9, lastPublishedAt: '2026-06-01T00:00:00Z' }, { counter: 2, publishedAt: '2026-06-24T00:00:00Z' })
    expect(b.lastCounter).toBe(9)
    expect(b.lastPublishedAt).toBe('2026-06-24T00:00:00Z') // floor timestamp is later
  })
})

describe('checkFreshness (fail-closed anti-rollback)', () => {
  const base: FreshnessBaseline = { lastCounter: 5, lastPublishedAt: '2026-06-24T00:00:00Z' }
  const NOW = Date.parse('2026-07-11T00:00:00Z')

  it('accepts a strictly newer counter with a non-regressing timestamp', () => {
    expect(checkFreshness({ counter: 6, publishedAt: '2026-06-25T00:00:00Z' }, base, { now: NOW })).toEqual({ ok: true })
  })

  it('accepts an equal timestamp when the counter advances (same-day release)', () => {
    expect(checkFreshness({ counter: 6, publishedAt: '2026-06-24T00:00:00Z' }, base, { now: NOW }).ok).toBe(true)
  })

  it('rejects an equal counter (replay)', () => {
    const r = checkFreshness({ counter: 5, publishedAt: '2026-07-01T00:00:00Z' }, base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('replay/downgrade')
  })

  it('rejects a lower counter (downgrade)', () => {
    expect(checkFreshness({ counter: 4, publishedAt: '2026-07-01T00:00:00Z' }, base).ok).toBe(false)
  })

  it('rejects a newer counter but an OLDER published_at (independent axis)', () => {
    const r = checkFreshness({ counter: 6, publishedAt: '2026-06-01T00:00:00Z' }, base)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('published_at')
  })

  it('rejects a non-integer counter', () => {
    expect(checkFreshness({ counter: 5.5, publishedAt: '2026-07-01T00:00:00Z' }, base).ok).toBe(false)
    expect(checkFreshness({ counter: NaN, publishedAt: '2026-07-01T00:00:00Z' }, base).ok).toBe(false)
  })

  it('rejects an unparseable published_at (fail-closed)', () => {
    expect(checkFreshness({ counter: 6, publishedAt: 'soon™' }, base).ok).toBe(false)
  })

  it('rejects a published_at beyond now + 48h skew', () => {
    const r = checkFreshness({ counter: 6, publishedAt: '2026-07-20T00:00:00Z' }, base, { now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('futuro')
  })

  it('allows a slightly-future published_at within the skew window', () => {
    const r = checkFreshness({ counter: 6, publishedAt: '2026-07-12T00:00:00Z' }, base, { now: NOW })
    expect(r.ok).toBe(true)
  })

  it('on a fresh install (null baseline timestamp) applies only counter + parse', () => {
    const fresh: FreshnessBaseline = { lastCounter: 0, lastPublishedAt: null }
    expect(checkFreshness({ counter: 1, publishedAt: '2020-01-01T00:00:00Z' }, fresh).ok).toBe(true)
    expect(checkFreshness({ counter: 0, publishedAt: '2020-01-01T00:00:00Z' }, fresh).ok).toBe(false)
  })

  it('labels the counter per artifact (version vs counter) in messages', () => {
    const r = checkFreshness({ counter: 5, publishedAt: '2026-07-01T00:00:00Z' }, base, { counterLabel: 'version' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('version')
  })
})
