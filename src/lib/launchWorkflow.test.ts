import { describe, it, expect } from 'vitest'
import { runLaunchWorkflow, SKYRIM_SE_APPID, type LaunchEnv } from './launchWorkflow'

// A fully-healthy environment; each test perturbs ONE thing.
function goodEnv(over: Partial<LaunchEnv> = {}): LaunchEnv {
  return {
    steam: { installed: true, running: true, path: 'C:/Steam', libraries: ['C:/Steam'] },
    skyrim: {
      appId: SKYRIM_SE_APPID,
      installed: true,
      path: 'C:/Steam/.../Skyrim Special Edition',
      version: '1.6.1170',
    },
    skse: { present: true, version: '2.2.6', gameVersionSupported: true },
    addressLibrary: { present: true, correctForVersion: true },
    mo2: { path: 'C:/MO2/ModOrganizer.exe', valid: true },
    mods: { total: 5, enabled: 5, installed: 5 },
    plugins: [{ name: 'SkyUI.esp', enabled: true }],
    modlist: { complete: true, missing: [] },
    manifest: { used: false, verified: false, reason: null },
    backups: { count: 2, lastValid: true },
    launchTarget: 'mo2',
    ...over,
  }
}

const find = (env: LaunchEnv, stage: string) => runLaunchWorkflow(env).checks.find((c) => c.stage === stage)!

describe('runLaunchWorkflow', () => {
  it('allows launch when everything is healthy', () => {
    const r = runLaunchWorkflow(goodEnv())
    expect(r.canLaunch).toBe(true)
    expect(r.blockingStage).toBeNull()
    expect(r.totals.fail).toBe(0)
  })

  it('Steam CLOSED → warning, still launchable (Steam can auto-start)', () => {
    const r = runLaunchWorkflow(
      goodEnv({ steam: { installed: true, running: false, path: 'C:/Steam', libraries: ['C:/Steam'] } }),
    )
    expect(
      find(goodEnv({ steam: { installed: true, running: false, path: null, libraries: [] } }), 'VerifySteam')
        .status,
    ).toBe('warning')
    expect(r.canLaunch).toBe(true)
  })

  it('Steam NOT INSTALLED → critical fail, blocks launch', () => {
    const r = runLaunchWorkflow(
      goodEnv({ steam: { installed: false, running: false, path: null, libraries: [] } }),
    )
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifySteam')
    expect(r.firstFix).toMatch(/Installa Steam/i)
  })

  it('Skyrim MISSING → critical fail', () => {
    const r = runLaunchWorkflow(
      goodEnv({ skyrim: { appId: SKYRIM_SE_APPID, installed: false, path: null, version: null } }),
    )
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifySkyrim')
  })

  it('SKSE INCOMPATIBLE → critical fail', () => {
    const r = runLaunchWorkflow(
      goodEnv({ skse: { present: true, version: '2.0.20', gameVersionSupported: false } }),
    )
    expect(r.canLaunch).toBe(false)
    expect(
      find(goodEnv({ skse: { present: true, version: '2.0.20', gameVersionSupported: false } }), 'VerifySKSE')
        .status,
    ).toBe('fail')
  })

  it('Address Library WRONG → critical fail at VerifyDependencies', () => {
    const r = runLaunchWorkflow(goodEnv({ addressLibrary: { present: true, correctForVersion: false } }))
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifyDependencies')
  })

  it('MO2 path CORRUPT → critical fail at launch resolution', () => {
    const r = runLaunchWorkflow(goodEnv({ mo2: { path: 'C:/broken/none.exe', valid: false } }))
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('LaunchMO2OrSKSE')
    expect(r.firstFix).toMatch(/Mod Organizer 2/i)
  })

  it('Modlist INCOMPLETE → warning, NOT blocking', () => {
    const r = runLaunchWorkflow(goodEnv({ modlist: { complete: false, missing: ['CBBE', 'SkyUI'] } }))
    expect(find(goodEnv({ modlist: { complete: false, missing: ['CBBE'] } }), 'VerifyModlist').status).toBe(
      'warning',
    )
    expect(r.canLaunch).toBe(true)
  })

  it('Load order over 254 ESP/ESM → critical fail (ESL excluded)', () => {
    const plugins = Array.from({ length: 260 }, (_, i) => ({ name: `m${i}.esp`, enabled: true }))
    expect(runLaunchWorkflow(goodEnv({ plugins })).canLaunch).toBe(false)
    const esl = Array.from({ length: 400 }, (_, i) => ({ name: `e${i}.esl`, enabled: true }))
    expect(runLaunchWorkflow(goodEnv({ plugins: esl })).canLaunch).toBe(true)
  })

  it('reports the FIRST blocking stage in pipeline order', () => {
    // Steam missing AND MO2 broken → Steam (earlier stage) is the blocker
    const r = runLaunchWorkflow(
      goodEnv({
        steam: { installed: false, running: false, path: null, libraries: [] },
        mo2: { path: null, valid: false },
      }),
    )
    expect(r.blockingStage).toBe('VerifySteam')
  })

  it('no launch target configured → critical fail', () => {
    const r = runLaunchWorkflow(goodEnv({ launchTarget: null }))
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('LaunchMO2OrSKSE')
  })
})
