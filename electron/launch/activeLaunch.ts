import { runLaunchWorkflow } from '../../src/lib/launchWorkflow'
import type { LaunchEnv, LaunchCheck, LaunchStage } from '../../src/lib/launchWorkflow'
import type { EnsureSteamResult } from '../steam/steamControl'
import type { BootstrapTarget } from './bootstrapper'
import type { LauncherUpdateInfo } from './launcherUpdate'
import type { AutoRepairResult } from './autoRepair'

// ACTIVE launch pipeline — the orchestrator behind One-Click Play. Unlike the
// read-only companion report (runLaunchWorkflow), this drives the full ordered
// boot sequence the launcher owns end to end:
//
//   update → config → dependencies → game install → STEAM (start+wait+login)
//   → modded env → plugins → profile → integrity → BOOTSTRAP → game running
//
// It reuses runLaunchWorkflow for every read-only verdict (single source of the
// pass/fail logic) and adds the two ACTIVE stages the companion mode never had:
// making Steam ready, and firing the bootstrapper. Progress is streamed per stage
// so the UI can render a Nolvus-style checklist live. All IO is injected, so the
// whole ordering / stop-on-critical logic is unit-testable with fakes. Never
// throws — a thrown dep is caught and surfaced as a failed stage.

export type StepStatus = 'running' | 'ok' | 'warning' | 'fail' | 'skipped'

export interface LaunchProgress {
  index: number // 1-based
  total: number
  stage: string
  label: string
  status: StepStatus
  detail: string
  fix?: string
}

export interface ActiveLaunchResult {
  launched: boolean
  bootstrapperId: string | null
  bootstrapperName: string | null
  blockingStage: string | null
  message: string
  steps: LaunchProgress[] // terminal status of every stage that ran
}

export interface ActiveLaunchDeps {
  buildEnv: () => LaunchEnv
  ensureSteam: (env: LaunchEnv) => Promise<EnsureSteamResult>
  checkUpdate: () => Promise<LauncherUpdateInfo>
  resolveTarget: (env: LaunchEnv) => BootstrapTarget | null
  launchExe: (t: { exe: string; cwd: string; args: string[] }) => {
    success: boolean
    pid?: number
    error?: string
  }
  launchProtocol: (uri: string) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
  onProgress?: (ev: LaunchProgress) => void
  /** Called once after the bootstrapper fires successfully (smart-startup memory). */
  recordSuccess?: (target: BootstrapTarget, env: LaunchEnv) => void
  /** Riparazione automatica pre-verifica (registra estrazioni, deploya, ordina i plugin).
   *  Opzionale: assente → lo stadio è saltato e la pipeline resta quella di sola verifica. */
  autoRepair?: () => Promise<AutoRepairResult>
}

interface StageVerdict {
  status: Exclude<StepStatus, 'running'>
  detail: string
  fix?: string
  critical: boolean // a failed critical stage stops the pipeline
}

interface StageDef {
  stage: string
  label: string
  run: () => Promise<StageVerdict> | StageVerdict
}

const STATUS_RANK: Record<string, number> = { ok: 0, skipped: 0, warning: 1, fail: 2 }

/** Combine several workflow checks into one pipeline stage by taking the worst. */
function pickWorst(checks: LaunchCheck[]): LaunchCheck | null {
  let worst: LaunchCheck | null = null
  for (const c of checks) {
    if (!worst || STATUS_RANK[c.status] > STATUS_RANK[worst.status]) worst = c
  }
  return worst
}

function verdictFromChecks(checks: LaunchCheck[], fallbackDetail: string): StageVerdict {
  const w = pickWorst(checks)
  if (!w) return { status: 'skipped', detail: fallbackDetail, critical: false }
  return {
    status: w.status,
    detail: w.detail,
    fix: w.fix,
    critical: w.status === 'fail' && w.critical,
  }
}

export async function runActiveLaunch(deps: ActiveLaunchDeps): Promise<ActiveLaunchResult> {
  // `env`/`report` sono RIASSEGNABILI: lo stadio AutoRepair modifica il sistema (registra
  // estrazioni, deploya, ordina i plugin), quindi l'ambiente va riletto e il verdetto
  // ricalcolato — altrimenti le verifiche a valle boccerebbero uno stato già riparato.
  // Gli stadi leggono `env`/`report` al momento dell'esecuzione (run è lazy), non alla
  // definizione: la riassegnazione li raggiunge tutti.
  let env = deps.buildEnv()
  let report = runLaunchWorkflow(env)
  const byStage = (s: LaunchStage): LaunchCheck[] => report.checks.filter((c) => c.stage === s)

  // Riparazione automatica: l'unico stadio che AGISCE prima delle verifiche. Non è mai
  // critico — se una riparazione fallisce, sono le verifiche a valle a decidere se il
  // gioco può partire lo stesso.
  const repairVerdict = async (): Promise<StageVerdict> => {
    if (!deps.autoRepair) {
      return { status: 'skipped', detail: 'Riparazione automatica non disponibile', critical: false }
    }
    const r = await deps.autoRepair()
    if (r.changed) {
      env = deps.buildEnv()
      report = runLaunchWorkflow(env)
    }
    if (!r.enabled) return { status: 'skipped', detail: r.summary, critical: false }
    if (r.failed) {
      return {
        status: 'warning',
        detail: r.summary,
        fix: 'Controlla il log: se il gioco non parte, esegui il Deploy manualmente dalla Dashboard',
        critical: false,
      }
    }
    return { status: 'ok', detail: r.summary, critical: false }
  }

  // Object holder (not a bare `let`): TS won't narrow a property away across the
  // closures below, so the post-loop read stays BootstrapTarget | null.
  const holder: { bootstrap: BootstrapTarget | null } = { bootstrap: null }

  // Config = we have SOMETHING to launch (a target resolvable) and a game path.
  const configVerdict = (): StageVerdict => {
    const targetChecks = byStage('LaunchMO2OrSKSE')
    const skyrimChecks = byStage('VerifySkyrim')
    const w = pickWorst([...targetChecks, ...skyrimChecks])
    if (w && w.status === 'fail') return { status: 'fail', detail: w.detail, fix: w.fix, critical: true }
    // Solo il percorso del GIOCO conta: si avvia via SKSE interno, MO2 non è mai un target
    // (prima un percorso MO2 valido bastava a dichiarare la config a posto — e il consiglio
    // rimandava a un campo MO2 che nelle Impostazioni non esiste).
    return env.skyrim.path
      ? { status: 'ok', detail: 'Percorsi di avvio configurati', critical: false }
      : {
          status: 'fail',
          detail: 'Nessun percorso del gioco configurato',
          fix: 'Imposta la cartella di Skyrim AE nelle Impostazioni (o usa "Rileva Automaticamente")',
          critical: true,
        }
  }

  const profileVerdict = (): StageVerdict => {
    if (env.mods.total === 0)
      return {
        status: 'warning',
        detail: 'Nessuna mod nel profilo attivo',
        fix: 'Installa o abilita le mod del profilo',
        critical: false,
      }
    if (env.mods.enabled === 0)
      return {
        status: 'warning',
        detail: `${env.mods.installed} installate, 0 abilitate`,
        fix: 'Abilita le mod del profilo attivo',
        critical: false,
      }
    return {
      status: 'ok',
      detail: `Profilo attivo · ${env.mods.enabled}/${env.mods.total} mod abilitate`,
      critical: false,
    }
  }

  const updateVerdict = async (): Promise<StageVerdict> => {
    const u = await deps.checkUpdate()
    if (!u.checked) return { status: 'skipped', detail: 'Verifica aggiornamenti non attiva', critical: false }
    if (u.error)
      return { status: 'warning', detail: `Verifica non riuscita: ${u.error}`, fix: 'Riprova più tardi', critical: false }
    if (u.available)
      return {
        status: 'warning',
        detail: `Aggiornamento disponibile: v${u.latestVersion}`,
        fix: 'Installa l’aggiornamento del launcher',
        critical: false,
      }
    return { status: 'ok', detail: `Launcher aggiornato (v${u.currentVersion})`, critical: false }
  }

  const steamVerdict = async (): Promise<StageVerdict> => {
    const r = await deps.ensureSteam(env)
    if (r.ok)
      return {
        status: 'ok',
        detail: r.loggedIn ? `${r.message} · utente autenticato` : r.message,
        critical: false,
      }
    return {
      status: 'fail',
      detail: r.message,
      fix: r.timedOut ? 'Avvia Steam ed effettua il login, poi riprova' : 'Verifica l’installazione di Steam',
      critical: true,
    }
  }

  const bootstrapVerdict = async (): Promise<StageVerdict> => {
    const target = deps.resolveTarget(env)
    if (!target)
      return {
        status: 'fail',
        detail: 'Nessun metodo di avvio disponibile (SKSE / MO2 / DragonLoader)',
        fix: 'Installa SKSE64 o configura Mod Organizer 2',
        critical: true,
      }
    if (target.mode === 'protocol') {
      const res = target.uri
        ? await deps.launchProtocol(target.uri)
        : { success: false, error: 'URI di avvio mancante' }
      if (!res.success)
        return {
          status: 'fail',
          detail: `Avvio via ${target.bootstrapperName} fallito: ${res.error ?? 'errore sconosciuto'}`,
          critical: true,
        }
      holder.bootstrap = target
      return { status: 'ok', detail: target.description, critical: false }
    }
    const res = deps.launchExe({ exe: target.exe!, cwd: target.cwd!, args: target.args ?? [] })
    if (!res.success)
      return {
        status: 'fail',
        detail: `Avvio via ${target.bootstrapperName} fallito: ${res.error ?? 'errore sconosciuto'}`,
        critical: true,
      }
    holder.bootstrap = target
    return {
      status: 'ok',
      detail: `${target.description}${res.pid ? ` (pid ${res.pid})` : ''}`,
      critical: false,
    }
  }

  // Ordered pipeline — mirrors the spec's PIPELINE DI AVVIO exactly.
  const stages: StageDef[] = [
    { stage: 'CheckLauncherUpdate', label: 'Verifica aggiornamenti launcher', run: updateVerdict },
    { stage: 'VerifyConfig', label: 'Verifica configurazione', run: configVerdict },
    // PRIMA delle verifiche, non dopo: uno stadio di riparazione messo in coda non servirebbe
    // a nulla — la pipeline si ferma al primo fail critico e non ci arriverebbe mai.
    { stage: 'AutoRepair', label: 'Riparazione automatica', run: repairVerdict },
    {
      stage: 'VerifyDependencies',
      label: 'Verifica dipendenze',
      run: () => verdictFromChecks(byStage('VerifyDependencies'), 'Dipendenze non valutate'),
    },
    {
      stage: 'VerifyGameInstall',
      label: 'Verifica installazione del gioco',
      run: () => verdictFromChecks(byStage('VerifySkyrim'), 'Installazione non valutata'),
    },
    { stage: 'EnsureSteam', label: 'Verifica e avvio Steam', run: steamVerdict },
    {
      stage: 'VerifyModdedEnv',
      label: 'Verifica ambiente moddato',
      run: () => verdictFromChecks([...byStage('VerifySKSE'), ...byStage('VerifyModlist')], 'Ambiente non valutato'),
    },
    {
      stage: 'VerifyPlugins',
      label: 'Verifica plugin',
      run: () => verdictFromChecks(byStage('VerifyLoadOrder'), 'Plugin non valutati'),
    },
    { stage: 'VerifyProfile', label: 'Verifica stato del profilo', run: profileVerdict },
    {
      stage: 'VerifyIntegrity',
      label: 'Verifica integrità',
      run: () =>
        verdictFromChecks([...byStage('VerifyManifest'), ...byStage('VerifyBackups')], 'Integrità non valutata'),
    },
    { stage: 'Bootstrap', label: 'Avvio bootstrapper', run: bootstrapVerdict },
  ]

  const total = stages.length + 1 // + final "game running" marker
  const steps: LaunchProgress[] = []
  let blockingStage: string | null = null

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]
    const index = i + 1
    deps.onProgress?.({ index, total, stage: s.stage, label: s.label, status: 'running', detail: '…' })
    let v: StageVerdict
    try {
      v = await s.run()
    } catch (e) {
      v = { status: 'fail', detail: (e as Error).message, critical: true }
    }
    const ev: LaunchProgress = {
      index,
      total,
      stage: s.stage,
      label: s.label,
      status: v.status,
      detail: v.detail,
      fix: v.fix,
    }
    steps.push(ev)
    deps.onProgress?.(ev)
    if (v.status === 'fail' && v.critical) {
      blockingStage = s.stage
      return {
        launched: false,
        bootstrapperId: null,
        bootstrapperName: null,
        blockingStage,
        message: v.fix ? `${v.detail} → ${v.fix}` : v.detail,
        steps,
      }
    }
  }

  // All stages passed and the bootstrapper fired: the modded game is starting.
  if (holder.bootstrap) deps.recordSuccess?.(holder.bootstrap, env)
  const final: LaunchProgress = {
    index: total,
    total,
    stage: 'GameRunning',
    label: 'Avvio della versione moddata',
    status: 'ok',
    detail: holder.bootstrap ? `Avviato tramite ${holder.bootstrap.bootstrapperName}` : 'Avviato',
  }
  steps.push(final)
  deps.onProgress?.(final)

  return {
    launched: true,
    bootstrapperId: holder.bootstrap?.bootstrapperId ?? null,
    bootstrapperName: holder.bootstrap?.bootstrapperName ?? null,
    blockingStage: null,
    message: 'Avvio completato',
    steps,
  }
}
