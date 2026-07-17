import { describe, it, expect } from 'vitest'
import { runActiveLaunch, type ActiveLaunchDeps, type LaunchProgress } from './activeLaunch'
import type { LaunchEnv } from '../../src/lib/launchWorkflow'
import type { BootstrapTarget } from './bootstrapper'
import type { AutoRepairResult } from './autoRepair'

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
      'AutoRepair', // agisce PRIMA delle verifiche: in coda non verrebbe mai raggiunto
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
    expect(rec.progress.filter((e) => e.status === 'running')).toHaveLength(11)
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

// ── AutoRepair: il sistema si ripara da sé invece di bloccare l'utente ────────

describe('runActiveLaunch — riparazione automatica', () => {
  const repairResult = (over: Partial<AutoRepairResult> = {}): AutoRepairResult => ({
    enabled: true,
    actions: [],
    changed: false,
    failed: false,
    summary: 'Nessuna riparazione necessaria',
    ...over,
  })

  it('senza dep autoRepair lo stadio è saltato: la pipeline resta quella di sola verifica', async () => {
    const { deps, rec } = baseDeps()
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(true)
    expect(terminal(rec.progress).find((e) => e.stage === 'AutoRepair')?.status).toBe('skipped')
  })

  it('dopo una riparazione RILEGGE l’ambiente: le verifiche vedono lo stato riparato', async () => {
    let repaired = false
    const { deps } = baseDeps({
      // Prima della riparazione l'ambiente è rotto (nessun plugin, modlist incompleta);
      // dopo, torna verde. Senza rebuild le verifiche boccerebbero uno stato già sistemato.
      buildEnv: () => (repaired ? greenEnv() : greenEnv({ modlist: { complete: false, missing: ['CBBE'] } })),
      autoRepair: async () => {
        repaired = true
        return repairResult({ changed: true, summary: 'Riparato: 10 plugin ordinati e attivati' })
      },
    })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(true)
    expect(res.steps.find((s) => s.stage === 'VerifyModdedEnv')?.status).toBe('ok')
  })

  it('riparazione fallita → warning, NON blocca: decidono le verifiche a valle', async () => {
    const { deps, rec } = baseDeps({
      autoRepair: async () => repairResult({ failed: true, summary: 'Riparazione parziale: cross-volume' }),
    })
    const res = await runActiveLaunch(deps)
    const step = terminal(rec.progress).find((e) => e.stage === 'AutoRepair')!
    expect(step.status).toBe('warning')
    expect(res.launched).toBe(true) // ambiente comunque valido → si gioca
  })

  it('riparazione disattivata dall’utente → skipped, nessuna azione', async () => {
    const { deps, rec } = baseDeps({
      autoRepair: async () =>
        repairResult({ enabled: false, summary: 'Riparazione automatica disattivata' }),
    })
    await runActiveLaunch(deps)
    expect(terminal(rec.progress).find((e) => e.stage === 'AutoRepair')?.status).toBe('skipped')
  })

  it('DEPLOY di riparazione fallito + mod abilitate → BLOCCO CRITICO (mai avvio in versione base)', async () => {
    const { deps, rec } = baseDeps({
      autoRepair: async () =>
        repairResult({
          failed: true,
          summary: 'Riparazione parziale: Master mancanti nel deploy',
          actions: [
            {
              id: 'deploy',
              label: 'Collegamento mod e ordinamento plugin',
              changed: false,
              detail: 'deploy non riuscito',
              error: 'Master mancanti nel deploy: X richiede Y',
            },
          ],
        }),
    })
    const res = await runActiveLaunch(deps)
    expect(res.launched).toBe(false)
    expect(res.blockingStage).toBe('AutoRepair')
    expect(terminal(rec.progress).find((e) => e.stage === 'AutoRepair')?.status).toBe('fail')
    expect(res.message).toMatch(/inibito/)
  })

  it('DEPLOY di riparazione fallito ma NESSUNA mod abilitata → warning (vanilla voluto)', async () => {
    const { deps, rec } = baseDeps({
      buildEnv: () => greenEnv({ mods: { total: 5, enabled: 0, installed: 5 }, plugins: [] }),
      autoRepair: async () =>
        repairResult({
          failed: true,
          summary: 'Riparazione parziale: deploy non riuscito',
          actions: [
            { id: 'deploy', label: 'Collegamento mod', changed: false, detail: 'deploy non riuscito', error: 'x' },
          ],
        }),
    })
    const res = await runActiveLaunch(deps)
    expect(terminal(rec.progress).find((e) => e.stage === 'AutoRepair')?.status).toBe('warning')
    expect(res.launched).toBe(true)
  })

  it('autoRepair che LANCIA → stadio fallito, mai un crash della pipeline', async () => {
    const { deps } = baseDeps({
      autoRepair: async () => {
        throw new Error('deploy esploso')
      },
    })
    const res = await runActiveLaunch(deps)
    expect(res.blockingStage).toBe('AutoRepair')
    expect(res.steps.find((s) => s.stage === 'AutoRepair')?.detail).toBe('deploy esploso')
  })
})
