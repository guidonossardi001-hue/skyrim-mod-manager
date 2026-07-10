import { describe, it, expect } from 'vitest'
import {
  readSmartStartup,
  writeSmartStartup,
  recordLaunch,
  type KeyValueStore,
} from './launcherConfig'

function fakeStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data = { ...initial }
  return {
    data,
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v
    },
  }
}

describe('readSmartStartup', () => {
  it('returns defaults when nothing is stored', () => {
    const s = readSmartStartup(fakeStore())
    expect(s).toEqual({
      autoLaunch: false,
      lastBootstrapperId: null,
      lastProfileId: null,
      lastLaunchAt: null,
      launchCount: 0,
    })
  })

  it('coerces a corrupt/partial stored value to safe defaults', () => {
    const s = readSmartStartup(
      fakeStore({ smartStartup: { autoLaunch: 'yes', lastProfileId: 'nope', launchCount: -5 } }),
    )
    expect(s.autoLaunch).toBe(false)
    expect(s.lastProfileId).toBeNull()
    expect(s.launchCount).toBe(0)
  })

  it('reads back a valid value', () => {
    const s = readSmartStartup(
      fakeStore({ smartStartup: { autoLaunch: true, lastBootstrapperId: 'skse', launchCount: 3 } }),
    )
    expect(s.autoLaunch).toBe(true)
    expect(s.lastBootstrapperId).toBe('skse')
    expect(s.launchCount).toBe(3)
  })
})

describe('writeSmartStartup', () => {
  it('merges a patch over existing config and persists it', () => {
    const store = fakeStore({ smartStartup: { launchCount: 2 } })
    const next = writeSmartStartup(store, { autoLaunch: true })
    expect(next.autoLaunch).toBe(true)
    expect(next.launchCount).toBe(2)
    expect((store.data.smartStartup as { autoLaunch: boolean }).autoLaunch).toBe(true)
  })
})

describe('recordLaunch', () => {
  it('stamps bootstrapper/profile/time and increments the counter', () => {
    const store = fakeStore({ smartStartup: { launchCount: 1, autoLaunch: true } })
    const next = recordLaunch(store, { bootstrapperId: 'mo2', profileId: 7 }, '2026-07-10T12:00:00.000Z')
    expect(next.lastBootstrapperId).toBe('mo2')
    expect(next.lastProfileId).toBe(7)
    expect(next.lastLaunchAt).toBe('2026-07-10T12:00:00.000Z')
    expect(next.launchCount).toBe(2)
    expect(next.autoLaunch).toBe(true) // preserved
  })
})
