import { describe, it, expect } from 'vitest'
import { runActiveLaunch, type ActiveLaunchDeps, type LaunchProgress } from './activeLaunch'
import type { LaunchEnv } from '../../src/lib/launchWorkflow'
import type { BootstrapTarget } from './bootstrapper'

function greenEnv(over: Partial<LaunchEnv> = {}): LaunchEnv {
  return {
    steam: { installed: true, running: true, path: 'C:/Steam', libraries: ['C:/Steam'] },
    skyrim: { appId: 489830, installed: true, path: 'C:/Games/Skyrim', version: '1.6.1170' },
    skse: { present: true, version: '1.6.1170', gameVersionSupported: true },
    addressLibrary: { present: true, correctForVersion: true },
    mo2: { path: null, valid: false },
    mods: { total: 5, enabled: 5, installed: 5 },
    plugins: [{ name: 'a.esp', enabled: true }],
    modlist: { complete: true, missing: [] },
    manifest: { used: false, verified: false, reason: null },
    backups: { count: 1, lastValid: true },
    launchTarget: 'skse',
    ...over,
  }
}

const skseTarget: BootstrapTarget = {
  bootstrapperId: 'skse',
  bootstrapperName: 'SKSE64',
  mode: 'exe',
  exe: 'C:/Games/Skyrim/skse64_loader.exe',
  cwd: 'C:/Games/Skyrim',
  args: [],
  description: 'Avvio tramite Skyrim Script Extender',
}
const dragonTarget: BootstrapTarget = {
  bootstrapperId: 'dragonloader',
  bootstrapperName: 'DragonLoader',
  mode: 'protocol',
  uri: 'steam://run/489830',
  description: 'Avvio tramite meccanismo Steam legittimo',
}

interface Rec {
  progress: LaunchProgress[]
  exeCalls: number
  protocolCalls: number
  recorded: BootstrapTarget[]
}

function baseDeps(over: Partial<ActiveLaunchDeps> = {}): { deps: ActiveLaunchDeps; rec: Rec } {
  const rec: Rec = { progress: [], exeCalls: 0, protocolCalls: 0, recorded: [] }
  const deps: ActiveLaunchDeps = {
    buildEnv: () => greenEnv(),
    ensureSteam: async () => ({ ok: true, loggedIn: true, started: false, timedOut: false, message: 'Steam pronto' }),
    checkUpdate: async () => ({
      available: false,
      currentVersion: '1.0.0',
      latestVersion: null,
      error: null,
      checked: false,
    }),
    resolveTarget: () => skseTarget,
    launchExe: () => {
      rec.exeCalls++
      return { success: true, pid: 4242 }
    },
    launchProtocol: () => {
      rec.protocolCalls++
      return { success: true }
    },
    onProgress: (ev) => rec.progress.push(ev),
    recordSuccess: (t) => rec.recorded.push(t),
    ...over,
  }
  return { deps, rec }
}

const terminal = (p: LaunchProgress[]) => p.filter((e) => e.status !== 'running')

describe('runActiveLaunch — happy path', () => {
  it('runs every stage in order and launches via SKSE', async () => {
    const { deps, rec } = baseDeps()
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(true)
    expect(res.bootstrapperId).toBe('skse')
    expect(res.blockingStage).toBeNull()
    expect(rec.exeCalls).toBe(1)
    expect(rec.recorded).toHaveLength(1)

    const stages = terminal(rec.progress).map((e) => e.stage)
    expect(stages).toEqual([
      'CheckLauncherUpdate',
      'VerifyConfig',
      'VerifyDependencies',
      'VerifyGameInstall',
      'EnsureSteam',
      'VerifyModdedEnv',
      'VerifyPlugins',
      'VerifyProfile',
      'VerifyIntegrity',
      'Bootstrap',
      'GameRunning',
    ])
    // every stage also emitted a 'running' event first
    expect(rec.progress.filter((e) => e.status === 'running')).toHaveLength(10)
  })
})

describe('runActiveLaunch — Steam gate', () => {
  it('stops at EnsureSteam when Steam cannot be made ready, before bootstrap', async () => {
    const { deps, rec } = baseDeps({
      ensureSteam: async () => ({
        ok: false,
        loggedIn: false,
        started: true,
        timedOut: true,
        message: 'Steam è in esecuzione ma nessun utente ha effettuato l’accesso.',
      }),
    })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(false)
    expect(res.blockingStage).toBe('EnsureSteam')
    expect(rec.exeCalls).toBe(0) // never reached bootstrap
    expect(res.message).toMatch(/login|accesso|riprova/i)
  })
})

describe('runActiveLaunch — bootstrap failures', () => {
  it('fails when no bootstrapper is available', async () => {
    const { deps } = baseDeps({ resolveTarget: () => null })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(false)
    expect(res.blockingStage).toBe('Bootstrap')
  })

  it('fails when the executable cannot be spawned', async () => {
    const { deps } = baseDeps({ launchExe: () => ({ success: false, error: 'ENOENT' }) })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(false)
    expect(res.blockingStage).toBe('Bootstrap')
    expect(res.message).toMatch(/ENOENT/)
  })

  it('launches via the protocol bootstrapper (DragonLoader / steam://run)', async () => {
    const { deps, rec } = baseDeps({ resolveTarget: () => dragonTarget })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(true)
    expect(res.bootstrapperId).toBe('dragonloader')
    expect(rec.protocolCalls).toBe(1)
    expect(rec.exeCalls).toBe(0)
  })
})

describe('runActiveLaunch — non-blocking warnings', () => {
  it('continues past warnings (e.g. update available, profile has no enabled mods)', async () => {
    const { deps, rec } = baseDeps({
      checkUpdate: async () => ({
        available: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        error: null,
        checked: true,
      }),
      buildEnv: () => greenEnv({ mods: { total: 5, enabled: 0, installed: 5 } }),
    })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(true)
    const warnStages = terminal(rec.progress)
      .filter((e) => e.status === 'warning')
      .map((e) => e.stage)
    expect(warnStages).toContain('CheckLauncherUpdate')
    expect(warnStages).toContain('VerifyProfile')
  })
})

describe('runActiveLaunch — early critical check', () => {
  it('stops at VerifyConfig/GameInstall when Skyrim is not installed', async () => {
    const { deps, rec } = baseDeps({
      buildEnv: () =>
        greenEnv({
          skyrim: { appId: 489830, installed: false, path: null, version: null },
          launchTarget: null,
          mo2: { path: null, valid: false },
        }),
    })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(false)
    // config depends on a launch target + install; the first critical stage wins
    expect(['VerifyConfig', 'VerifyGameInstall']).toContain(res.blockingStage)
    expect(rec.exeCalls).toBe(0)
  })
})
