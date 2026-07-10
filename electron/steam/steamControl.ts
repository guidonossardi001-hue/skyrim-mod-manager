import { execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { isSteamRunning } from './detect'

// ACTIVE Steam control (NOT companion mode). Unlike steam/detect.ts — which is
// strictly read-only — this module can START the official Steam client and WAIT
// for it to become login-ready, because the launcher must guarantee a running,
// AUTHENTICATED Steam session before it hands off to the bootstrapper: Steam
// overlay, achievements, playtime and cloud only work when the game is launched
// under a live, logged-in session. It NEVER bypasses Steam — it only starts the
// legitimate client and polls its own state; the modded game itself is launched
// later through the sanctioned mechanism (SKSE loader / steam://run/489830).

// Absolute System32 path: invoking reg.exe by BARE name lets a planted reg.exe on
// PATH/CWD run instead of the real tool (binary-planting). Same rule as detect.ts.
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const REG_EXE = join(SYS32, 'reg.exe')

function regQueryDword(key: string, value: string): number | null {
  try {
    const out = execFileSync(REG_EXE, ['query', key, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    const m = out.match(new RegExp(`${value}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`, 'i'))
    return m ? parseInt(m[1], 16) : null
  } catch {
    return null
  }
}

/**
 * HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser is a DWORD Steam sets to the
 * signed-in account id while a session is authenticated, and resets to 0 the
 * instant the user signs out or Steam is stuck on the login screen. It is the
 * standard read-only signal third-party launchers use to know Steam is not merely
 * running but actually logged in. Returns 0 when absent/logged-out.
 */
export function getSteamActiveUser(): number {
  return regQueryDword('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser') ?? 0
}

export function isSteamLoggedIn(): boolean {
  return getSteamActiveUser() > 0
}

export interface StartSteamResult {
  started: boolean
  error?: string
}

/**
 * Launch the official Steam client detached from Electron (so quitting the
 * launcher never kills Steam). No `-silent`: we want Steam to initialize and, if
 * needed, surface its own login window so the user can authenticate. No-throw.
 */
export function startSteam(steamPath: string): StartSteamResult {
  const exe = join(steamPath, 'steam.exe')
  if (!existsSync(exe)) return { started: false, error: `steam.exe non trovato: ${exe}` }
  try {
    const child = spawn(exe, [], {
      cwd: steamPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    // A late async spawn failure surfaces as an 'error' event; without a listener
    // Node would crash the whole main process on it.
    child.on('error', () => {})
    child.unref()
    return { started: true }
  } catch (e) {
    return { started: false, error: (e as Error).message }
  }
}

export type SteamReadiness = 'ready' | 'running-not-logged-in' | 'not-running'

/** Pure verdict from the two observable signals — the whole IO surface reduces to this. */
export function evaluateSteamReadiness(running: boolean, activeUser: number): SteamReadiness {
  if (!running) return 'not-running'
  return activeUser > 0 ? 'ready' : 'running-not-logged-in'
}

export interface SteamProbe {
  running: boolean
  activeUser: number
}

/** Live probe wiring the read-only signals from detect.ts + this module. */
export function liveSteamProbe(): SteamProbe {
  return { running: isSteamRunning(), activeUser: getSteamActiveUser() }
}

export interface WaitSteamOptions {
  timeoutMs?: number // default 60000
  intervalMs?: number // default 1500
  requireLogin?: boolean // default true — a running-but-logged-out client is not "ready"
}

export interface WaitSteamResult {
  ready: boolean
  loggedIn: boolean
  running: boolean
  timedOut: boolean
  waitedMs: number
}

/**
 * Poll `probe` until Steam is ready (running, and — unless requireLogin is false —
 * logged in) or the timeout elapses. `sleep` is injected so tests drive it with a
 * fake clock (resolve-immediately) and count iterations without real waiting.
 * Checks once immediately, then on `intervalMs` cadence up to `timeoutMs`.
 */
export async function waitForSteamReady(
  probe: () => SteamProbe,
  opts: WaitSteamOptions = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<WaitSteamResult> {
  const timeoutMs = opts.timeoutMs ?? 60000
  const intervalMs = opts.intervalMs ?? 1500
  const requireLogin = opts.requireLogin ?? true
  let waited = 0
  for (;;) {
    const s = probe()
    const ready = s.running && (!requireLogin || s.activeUser > 0)
    if (ready) {
      return { ready: true, loggedIn: s.activeUser > 0, running: s.running, timedOut: false, waitedMs: waited }
    }
    if (waited >= timeoutMs) {
      return { ready: false, loggedIn: s.activeUser > 0, running: s.running, timedOut: true, waitedMs: waited }
    }
    await sleep(intervalMs)
    waited += intervalMs
  }
}

export interface EnsureSteamDeps {
  probe: () => SteamProbe
  start: () => StartSteamResult
  sleep?: (ms: number) => Promise<void>
}

export interface EnsureSteamResult {
  ok: boolean
  loggedIn: boolean
  started: boolean // whether THIS call started Steam
  timedOut: boolean
  error?: string
  message: string // human-facing, ready to show / log
}

/**
 * Full "make Steam ready" flow for the launch pipeline:
 *   • already ready            → return immediately, don't touch Steam;
 *   • not running              → start it, then wait for login;
 *   • running but logged out   → wait for the user to sign in (never restart).
 * On timeout returns ok:false with a message that distinguishes "Steam didn't
 * come up" from "Steam is up but nobody is logged in", each with the fix. No-throw.
 */
export async function ensureSteamReady(
  deps: EnsureSteamDeps,
  opts: WaitSteamOptions = {},
): Promise<EnsureSteamResult> {
  const requireLogin = opts.requireLogin ?? true
  const first = deps.probe()
  if (first.running && (!requireLogin || first.activeUser > 0)) {
    return {
      ok: true,
      loggedIn: first.activeUser > 0,
      started: false,
      timedOut: false,
      message: 'Steam già in esecuzione e pronto',
    }
  }

  let started = false
  if (!first.running) {
    const s = deps.start()
    if (!s.started) {
      return {
        ok: false,
        loggedIn: false,
        started: false,
        timedOut: false,
        error: s.error,
        message: `Impossibile avviare Steam: ${s.error ?? 'errore sconosciuto'}. Avvia Steam manualmente e riprova.`,
      }
    }
    started = true
  }

  const w = await waitForSteamReady(deps.probe, opts, deps.sleep)
  if (w.ready) {
    return {
      ok: true,
      loggedIn: w.loggedIn,
      started,
      timedOut: false,
      message: started ? 'Steam avviato e pronto' : 'Steam pronto',
    }
  }
  if (!w.running) {
    return {
      ok: false,
      loggedIn: false,
      started,
      timedOut: true,
      message: 'Steam non si è avviato entro il tempo previsto. Avvia Steam manualmente e riprova.',
    }
  }
  return {
    ok: false,
    loggedIn: false,
    started,
    timedOut: true,
    message: 'Steam è in esecuzione ma nessun utente ha effettuato l’accesso. Effettua il login su Steam e riprova.',
  }
}
