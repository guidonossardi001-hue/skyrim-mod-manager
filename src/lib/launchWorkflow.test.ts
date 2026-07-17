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
    // MO2 resta nell'env solo come informazione diagnostica: NON è un target di avvio
    // (il launcher usa sempre il proprio SKSE), quindi non influenza mai il verdetto.
    mo2: { path: 'C:/MO2/ModOrganizer.exe', valid: true },
    mods: { total: 5, enabled: 5, installed: 5 },
    plugins: [{ name: 'SkyUI.esp', enabled: true }],
    modlist: { complete: true, missing: [] },
    manifest: { used: false, verified: false, reason: null },
    backups: { count: 2, lastValid: true },
    launchTarget: 'skse', // l'unico target reale: buildLaunchEnv risolve solo 'skse' o null
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

  it('MO2 rotto o assente NON blocca: non è un target di avvio', () => {
    // Prima questo caso era un fail critico che consigliava "configura MO2 nelle
    // Impostazioni" — un campo che non esiste, per un tool mai usato all'avvio.
    for (const mo2 of [{ path: 'C:/broken/none.exe', valid: false }, { path: null, valid: false }]) {
      const r = runLaunchWorkflow(goodEnv({ mo2 }))
      expect(r.canLaunch).toBe(true)
      expect(r.checks.find((c) => c.stage === 'LaunchMO2OrSKSE')?.status).toBe('ok')
    }
  })

  it('nessun target: il consiglio punta a SKSE, mai a MO2 (vicolo cieco)', () => {
    const r = runLaunchWorkflow(goodEnv({ launchTarget: null }))
    expect(r.canLaunch).toBe(false)
    expect(r.firstFix).toMatch(/SKSE64/i)
    expect(r.firstFix).not.toMatch(/Mod Organizer/i)
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

  // ── Probe opzionali (updateGuard / deployIntegrity / saveDoctor) ────────────

  it('env senza probe opzionali → nessun check aggiuntivo (retrocompatibile)', () => {
    const stages = runLaunchWorkflow(goodEnv()).checks.map((c) => c.label)
    expect(stages).not.toContain('Protezione aggiornamenti attiva')
    expect(stages.some((l) => /Deploy/.test(l))).toBe(false)
  })

  it('drift versione (update Steam avvenuto) → warning con from→to, non blocca', () => {
    const r = runLaunchWorkflow(
      goodEnv({
        updateGuard: {
          found: true,
          protected: true,
          drift: { changed: true, from: '1.6.1170.0', to: '1.6.1180.0' },
        },
      }),
    )
    const c = r.checks.find((x) => x.label === 'Skyrim aggiornato da Steam')!
    expect(c.status).toBe('warning')
    expect(c.detail).toContain('1.6.1170.0 → 1.6.1180.0')
    expect(r.canLaunch).toBe(true)
  })

  it('guard non protetto senza drift → warning "attiva la protezione"', () => {
    const r = runLaunchWorkflow(
      goodEnv({ updateGuard: { found: true, protected: false, drift: { changed: false, from: 'x', to: 'x' } } }),
    )
    expect(r.checks.find((x) => x.label === 'Aggiornamenti Steam non bloccati')?.status).toBe('warning')
  })

  it('guard protetto → ok', () => {
    const r = runLaunchWorkflow(goodEnv({ updateGuard: { found: true, protected: true, drift: null } }))
    expect(r.checks.find((x) => x.label === 'Protezione aggiornamenti attiva')?.status).toBe('ok')
  })

  it('deploy alterato esternamente → warning con conteggi', () => {
    const r = runLaunchWorkflow(
      goodEnv({
        deployIntegrity: {
          checked: true,
          totalFiles: 100,
          missingCount: 2,
          replacedCount: 1,
          junctionsMissingCount: 0,
        },
      }),
    )
    const c = r.checks.find((x) => x.label === 'Deploy alterato esternamente')!
    expect(c.status).toBe('warning')
    expect(c.detail).toContain('2 file mancanti')
    expect(c.detail).toContain('1 sostituiti')
    expect(r.canLaunch).toBe(true)
  })

  it('deploy integro → ok con totale verificato', () => {
    const r = runLaunchWorkflow(
      goodEnv({
        deployIntegrity: { checked: true, totalFiles: 100, missingCount: 0, replacedCount: 0, junctionsMissingCount: 0 },
      }),
    )
    expect(r.checks.find((x) => x.label === 'Deploy integro')?.detail).toContain('100 file')
  })

  // ── Regressione REALE (2026-07-17): il gioco è stato avviato VANILLA ──────────
  // Il deploy era fallito, plugins.txt di sistema conteneva 1 sola riga, ma la checklist
  // segnava "0/254 slot [ok]" e il lancio è proseguito: il check aveva solo il tetto.

  it('ZERO plugin con mod abilitate → BLOCCA: il gioco partirebbe vanilla', () => {
    const r = runLaunchWorkflow(
      goodEnv({ plugins: [], mods: { total: 1939, enabled: 1939, installed: 1939 }, pluginsSource: 'system' }),
    )
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifyLoadOrder')
    expect(r.firstFix).toMatch(/Deploy/i)
  })

  it('ZERO plugin ma NESSUNA mod abilitata → nessun blocco (vanilla voluto)', () => {
    const r = runLaunchWorkflow(goodEnv({ plugins: [], mods: { total: 1939, enabled: 0, installed: 1939 } }))
    expect(r.canLaunch).toBe(true)
  })

  // Secondo avvio vanilla REALE (2026-07-17): plugins.txt con 1 riga residua (quindi NON
  // vuota, il check "zero plugin" non scattava), 1939 mod abilitate, nessun manifest di
  // deploy, save vecchio senza plugin a rischio → tutte le maglie passavano.
  it('1 plugin residuo + 1939 mod abilitate + manifest assente → BLOCCA (gate 7-bis)', () => {
    const r = runLaunchWorkflow(
      goodEnv({
        plugins: [{ name: 'AnimeFollower.esp', enabled: true }],
        pluginsSource: 'system',
        mods: { total: 1939, enabled: 1939, installed: 1939 },
        deployIntegrity: { checked: false, totalFiles: 0, missingCount: 0, replacedCount: 0, junctionsMissingCount: 0 },
        saveDoctor: { checked: true, saveName: 'old.ess', missingCount: 0, missingPlugins: [] },
      }),
    )
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifyLoadOrder')
    expect(r.checks.find((c) => c.label === 'Ambiente moddato non collegato al gioco')?.detail).toMatch(/vanilla/i)
  })

  it('plugins.txt non trovata → il dettaglio lo dice (diagnosi, non "0 plugin")', () => {
    const r = runLaunchWorkflow(
      goodEnv({ plugins: [], mods: { total: 5, enabled: 5, installed: 5 }, pluginsSource: 'none' }),
    )
    expect(r.checks.find((c) => c.label === 'Nessun plugin attivo')?.detail).toMatch(/non trovata/i)
  })

  // ── Gate anti-corruzione del salvataggio: le 3 condizioni ────────────────────

  const risky = {
    saveDoctor: { checked: true, saveName: 'hero.ess', missingCount: 12, missingPlugins: ['A.esp', 'B.esp'] },
    deployIntegrity: { checked: false, totalFiles: 0, missingCount: 0, replacedCount: 0, junctionsMissingCount: 0 },
    mods: { total: 1939, enabled: 1939, installed: 1939 },
  }

  it('save a rischio + deploy assente + mod abilitate → BLOCCA (le 3 condizioni)', () => {
    const r = runLaunchWorkflow(goodEnv(risky))
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifyLoadOrder')
    // Bloccano ENTRAMBI i gate: quello rigoroso (manifest assente) e quello del save.
    expect(r.checks.some((c) => c.status === 'fail' && /hero\.ess/.test(c.detail))).toBe(true)
  })

  it('save a rischio MA deploy INTEGRO → nessun blocco (le mod sono collegate ora)', () => {
    const r = runLaunchWorkflow(
      goodEnv({
        ...risky,
        deployIntegrity: { checked: true, totalFiles: 500, missingCount: 0, replacedCount: 0, junctionsMissingCount: 0 },
      }),
    )
    expect(r.canLaunch).toBe(true)
    expect(r.checks.find((c) => c.label === 'Ultimo salvataggio a rischio')?.status).toBe('warning')
  })

  it('save a rischio MA nessuna mod abilitata → nessun blocco (vanilla voluto)', () => {
    const r = runLaunchWorkflow(goodEnv({ ...risky, mods: { total: 1939, enabled: 0, installed: 1939 } }))
    expect(r.canLaunch).toBe(true)
  })

  // Direttiva 2026-07-17 (secondo avvio vanilla reale): il gate rigoroso 7-bis blocca su
  // manifest ASSENTE + mod abilitate ANCHE senza prova di danno al save — un save sano o
  // assente non rende accettabile avviare la versione base con 1939 mod abilitate.
  it('deploy MAI eseguito + mod abilitate → BLOCCA anche con save sano', () => {
    const r = runLaunchWorkflow(
      goodEnv({
        ...risky,
        saveDoctor: { checked: true, saveName: 'hero.ess', missingCount: 0, missingPlugins: [] },
      }),
    )
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifyLoadOrder')
    expect(r.checks.find((c) => c.label === 'Ambiente moddato non collegato al gioco')?.status).toBe('fail')
  })

  it('deploy MAI eseguito + mod abilitate → BLOCCA anche senza save verificabile', () => {
    const r = runLaunchWorkflow(
      goodEnv({ ...risky, saveDoctor: { checked: false, saveName: null, missingCount: 0, missingPlugins: [] } }),
    )
    expect(r.canLaunch).toBe(false)
    expect(r.blockingStage).toBe('VerifyLoadOrder')
  })

  it('save con plugin mancanti → warning con nomi; save coerente → ok; non verificato → silenzio', () => {
    const warn = runLaunchWorkflow(
      goodEnv({
        // Deploy INTEGRO: le mod sono collegate ora, quindi il save a rischio resta un
        // avviso informativo. Senza deploy integro lo stesso input BLOCCA (vedi gate sopra).
        deployIntegrity: {
          checked: true,
          totalFiles: 100,
          missingCount: 0,
          replacedCount: 0,
          junctionsMissingCount: 0,
        },
        saveDoctor: {
          checked: true,
          saveName: 'hero.ess',
          missingCount: 2,
          missingPlugins: ['Gone.esp', 'Away.esl'],
        },
      }),
    ).checks.find((x) => x.label === 'Ultimo salvataggio a rischio')!
    expect(warn.status).toBe('warning')
    expect(warn.detail).toContain('hero.ess')
    expect(warn.detail).toContain('Gone.esp')

    const okRun = runLaunchWorkflow(
      goodEnv({ saveDoctor: { checked: true, saveName: 'hero.ess', missingCount: 0, missingPlugins: [] } }),
    )
    expect(okRun.checks.find((x) => x.label === 'Salvataggio coerente')?.status).toBe('ok')

    const silent = runLaunchWorkflow(
      goodEnv({ saveDoctor: { checked: false, saveName: null, missingCount: 0, missingPlugins: [] } }),
    )
    expect(silent.checks.some((x) => /salvataggio/i.test(x.label))).toBe(false)
  })
})
