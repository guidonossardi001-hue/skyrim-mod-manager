import { describe, it, expect } from 'vitest'
import {
  evaluateSteamReadiness,
  waitForSteamReady,
  ensureSteamReady,
  type SteamProbe,
} from './steamControl'

const noSleep = async () => {}

describe('evaluateSteamReadiness', () => {
  it('classifies the three observable states', () => {
    expect(evaluateSteamReadiness(false, 0)).toBe('not-running')
    expect(evaluateSteamReadiness(true, 0)).toBe('running-not-logged-in')
    expect(evaluateSteamReadiness(true, 76561198000000000 % 2147483647)).toBe('ready')
  })
})

describe('waitForSteamReady', () => {
  it('returns ready immediately when already running + logged in (no sleep)', async () => {
    let calls = 0
    const probe = (): SteamProbe => {
      calls++
      return { running: true, activeUser: 42 }
    }
    const r = await waitForSteamReady(probe, { timeoutMs: 10000, intervalMs: 1000 }, noSleep)
    expect(r.ready).toBe(true)
    expect(r.loggedIn).toBe(true)
    expect(r.waitedMs).toBe(0)
    expect(calls).toBe(1)
  })

  it('polls until Steam becomes logged-in', async () => {
    const states: SteamProbe[] = [
      { running: false, activeUser: 0 },
      { running: true, activeUser: 0 }, // launched, not yet logged in
      { running: true, activeUser: 0 },
      { running: true, activeUser: 7 }, // logged in
    ]
    let i = 0
    const probe = (): SteamProbe => states[Math.min(i++, states.length - 1)]
    const r = await waitForSteamReady(probe, { timeoutMs: 10000, intervalMs: 1000 }, noSleep)
    expect(r.ready).toBe(true)
    expect(r.loggedIn).toBe(true)
    expect(r.waitedMs).toBe(3000) // three interval waits before the 4th probe
  })

  it('times out when Steam never logs in, reporting running=true', async () => {
    const probe = (): SteamProbe => ({ running: true, activeUser: 0 })
    const r = await waitForSteamReady(probe, { timeoutMs: 3000, intervalMs: 1000 }, noSleep)
    expect(r.ready).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.running).toBe(true)
    expect(r.loggedIn).toBe(false)
  })

  it('honors requireLogin:false — running alone is ready', async () => {
    const probe = (): SteamProbe => ({ running: true, activeUser: 0 })
    const r = await waitForSteamReady(probe, { timeoutMs: 3000, intervalMs: 1000, requireLogin: false }, noSleep)
    expect(r.ready).toBe(true)
    expect(r.loggedIn).toBe(false)
  })
})

describe('ensureSteamReady', () => {
  it('short-circuits when already ready and never starts Steam', async () => {
    let startCalls = 0
    const r = await ensureSteamReady(
      {
        probe: () => ({ running: true, activeUser: 9 }),
        start: () => {
          startCalls++
          return { started: true }
        },
        sleep: noSleep,
      },
      { timeoutMs: 5000, intervalMs: 1000 },
    )
    expect(r.ok).toBe(true)
    expect(r.started).toBe(false)
    expect(startCalls).toBe(0)
  })

  it('starts Steam when down, then reports ready once logged in', async () => {
    const states: SteamProbe[] = [
      { running: false, activeUser: 0 }, // initial: down
      { running: true, activeUser: 0 }, // after start
      { running: true, activeUser: 5 }, // logged in
    ]
    let i = 0
    let started = false
    const r = await ensureSteamReady(
      {
        probe: () => states[Math.min(i++, states.length - 1)],
        start: () => {
          started = true
          return { started: true }
        },
        sleep: noSleep,
      },
      { timeoutMs: 5000, intervalMs: 1000 },
    )
    expect(started).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.started).toBe(true)
    expect(r.loggedIn).toBe(true)
  })

  it('fails clearly when Steam cannot be started', async () => {
    const r = await ensureSteamReady(
      {
        probe: () => ({ running: false, activeUser: 0 }),
        start: () => ({ started: false, error: 'steam.exe non trovato' }),
        sleep: noSleep,
      },
      { timeoutMs: 2000, intervalMs: 1000 },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('steam.exe')
    expect(r.message).toMatch(/manualmente/i)
  })

  it('does NOT restart a running-but-logged-out client, and times out on login', async () => {
    let startCalls = 0
    const r = await ensureSteamReady(
      {
        probe: () => ({ running: true, activeUser: 0 }),
        start: () => {
          startCalls++
          return { started: true }
        },
        sleep: noSleep,
      },
      { timeoutMs: 2000, intervalMs: 1000 },
    )
    expect(startCalls).toBe(0) // already running → never spawn a second client
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.message).toMatch(/login|accesso/i)
  })
})
