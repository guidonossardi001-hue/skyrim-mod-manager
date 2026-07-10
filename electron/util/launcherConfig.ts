// SMART STARTUP config — the launcher's persisted "last known good" so the user
// never reconfigures anything between runs (One-Click Play). Stored under a single
// electron-store key. Kept Electron-free and pure over a minimal KeyValueStore so
// it's fully unit-testable with an in-memory fake, and every read is validated /
// defaulted (a corrupt or partial value can never crash the launch path).

export interface SmartStartupConfig {
  /** One-click: auto-run the launch pipeline as soon as the launcher opens. */
  autoLaunch: boolean
  /** Bootstrapper used by the last successful launch (SKSE / MO2 / DragonLoader). */
  lastBootstrapperId: string | null
  /** Profile active at the last launch. */
  lastProfileId: number | null
  /** ISO timestamp of the last successful launch. */
  lastLaunchAt: string | null
  /** Total successful launches (telemetry / "you've played N times"). */
  launchCount: number
}

const KEY = 'smartStartup'

const DEFAULTS: SmartStartupConfig = {
  autoLaunch: false,
  lastBootstrapperId: null,
  lastProfileId: null,
  lastLaunchAt: null,
  launchCount: 0,
}

export interface KeyValueStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export function readSmartStartup(store: KeyValueStore): SmartStartupConfig {
  const raw = store.get(KEY)
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
  const r = raw as Partial<SmartStartupConfig>
  return {
    autoLaunch: typeof r.autoLaunch === 'boolean' ? r.autoLaunch : DEFAULTS.autoLaunch,
    lastBootstrapperId: typeof r.lastBootstrapperId === 'string' ? r.lastBootstrapperId : null,
    lastProfileId: typeof r.lastProfileId === 'number' ? r.lastProfileId : null,
    lastLaunchAt: typeof r.lastLaunchAt === 'string' ? r.lastLaunchAt : null,
    launchCount: typeof r.launchCount === 'number' && r.launchCount >= 0 ? r.launchCount : 0,
  }
}

export function writeSmartStartup(
  store: KeyValueStore,
  patch: Partial<SmartStartupConfig>,
): SmartStartupConfig {
  const next = { ...readSmartStartup(store), ...patch }
  store.set(KEY, next)
  return next
}

/**
 * Record a successful launch — remembers the bootstrapper + profile for next time.
 * `nowIso` is injected so tests stay deterministic (no wall-clock in the module).
 */
export function recordLaunch(
  store: KeyValueStore,
  info: { bootstrapperId: string; profileId: number | null },
  nowIso: string,
): SmartStartupConfig {
  const prev = readSmartStartup(store)
  return writeSmartStartup(store, {
    lastBootstrapperId: info.bootstrapperId,
    lastProfileId: info.profileId,
    lastLaunchAt: nowIso,
    launchCount: prev.launchCount + 1,
  })
}
