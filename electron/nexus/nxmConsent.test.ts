import { describe, it, expect } from 'vitest'
import { NxmConsentStore } from './nxmConsent'
import type { NxmLink } from './nxm'

const link = (over: Partial<NxmLink> = {}): NxmLink => ({
  game: 'skyrimspecialedition',
  modId: 2347,
  fileId: 12345,
  ...over,
})

// Deterministic token generator (no Math.random) so assertions are stable.
function counterTokens() {
  let n = 0
  return () => `t${++n}`
}

describe('NxmConsentStore', () => {
  it('add -> list exposes the request but NEVER the non-premium key', () => {
    const s = new NxmConsentStore({ genToken: counterTokens() })
    const r = s.add(link({ key: 'secret-key' }), 1000)
    expect(r).toEqual({ ok: true, token: 't1' })
    const view = s.list()
    expect(view).toHaveLength(1)
    expect(view[0]).toMatchObject({ token: 't1', modId: 2347, fileId: 12345, hasKey: true })
    // the key must not leak into the UI-facing view
    expect(JSON.stringify(view)).not.toContain('secret-key')
  })

  it('take returns the FULL request (with link+key) once, then it is gone', () => {
    const s = new NxmConsentStore({ genToken: counterTokens() })
    const { token } = s.add(link({ key: 'k' }), 1) as { ok: true; token: string }
    const taken = s.take(token)
    expect(taken?.link.key).toBe('k')
    expect(s.take(token)).toBeNull() // not takeable twice
    expect(s.size()).toBe(0)
  })

  it('reject drops a request without downloading (default-deny)', () => {
    const s = new NxmConsentStore({ genToken: counterTokens() })
    const { token } = s.add(link(), 1) as { ok: true; token: string }
    expect(s.reject(token)).toBe(true)
    expect(s.reject(token)).toBe(false) // already gone
    expect(s.list()).toHaveLength(0)
  })

  it('enforces the cap (anti-flood) — extra requests are refused, not queued', () => {
    const s = new NxmConsentStore({ genToken: counterTokens(), cap: 2 })
    expect(s.add(link(), 1).ok).toBe(true)
    expect(s.add(link(), 2).ok).toBe(true)
    const third = s.add(link(), 3)
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toContain('troppe richieste')
    expect(s.size()).toBe(2)
  })

  it('frees a slot after take/reject so a legit request fits again', () => {
    const s = new NxmConsentStore({ genToken: counterTokens(), cap: 1 })
    const { token } = s.add(link(), 1) as { ok: true; token: string }
    expect(s.add(link(), 2).ok).toBe(false) // full
    s.take(token)
    expect(s.add(link(), 3).ok).toBe(true) // slot freed
  })

  it('patch attaches a best-effort name; list is ordered oldest-first', () => {
    const s = new NxmConsentStore({ genToken: counterTokens() })
    const a = s.add(link({ modId: 1 }), 200) as { ok: true; token: string }
    s.add(link({ modId: 2 }), 100)
    s.patch(a.token, { name: 'SkyUI' })
    const view = s.list()
    expect(view.map((v) => v.modId)).toEqual([2, 1]) // receivedAt 100 before 200
    expect(view.find((v) => v.token === a.token)?.name).toBe('SkyUI')
  })
})
