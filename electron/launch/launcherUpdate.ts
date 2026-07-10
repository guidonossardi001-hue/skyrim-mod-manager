import { app } from 'electron'
import { createRequire } from 'module'
import { logger } from '../logger'

// Launcher self-update check — the first stage of the boot pipeline
// ("Verifica aggiornamenti del launcher"). electron-updater is an OPTIONAL runtime
// dependency: it's declared in package.json and installed with the app, but loaded
// here through createRequire inside a try/catch so the launcher (and typecheck /
// tests) degrade cleanly when it is absent — e.g. running from source before
// `npm install`, or a build with no publish feed. This stage is BEST-EFFORT: it
// never blocks launch. User data lives in app.getPath('userData'), separate from
// the install dir, so an update never touches saved profiles/config.

export interface LauncherUpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  error: string | null
  checked: boolean // false when the check was skipped (dev / updater absent)
}

type AutoUpdaterLike = {
  autoDownload: boolean
  checkForUpdates: () => Promise<{ updateInfo?: { version?: string } } | null>
}

const nodeRequire = createRequire(__filename)

function loadAutoUpdater(): AutoUpdaterLike | null {
  try {
    const mod = nodeRequire('electron-updater') as { autoUpdater?: AutoUpdaterLike }
    return mod.autoUpdater ?? null
  } catch {
    return null
  }
}

function safeVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

export async function checkForLauncherUpdate(): Promise<LauncherUpdateInfo> {
  const currentVersion = safeVersion()
  // Auto-update only makes sense on a packaged build wired to a publish feed.
  if (!app.isPackaged) {
    return { available: false, currentVersion, latestVersion: null, error: null, checked: false }
  }
  const updater = loadAutoUpdater()
  if (!updater) {
    return { available: false, currentVersion, latestVersion: null, error: null, checked: false }
  }
  try {
    updater.autoDownload = false // report only — download stays user-driven
    const res = await updater.checkForUpdates()
    const latest = res?.updateInfo?.version ?? null
    return {
      available: !!latest && latest !== currentVersion,
      currentVersion,
      latestVersion: latest,
      error: null,
      checked: true,
    }
  } catch (e) {
    // A missing/unreachable feed must NEVER block launch. Log and continue.
    const error = (e as Error).message
    logger.warn('launcher-update', `verifica aggiornamenti launcher fallita: ${error}`)
    return { available: false, currentVersion, latestVersion: null, error, checked: true }
  }
}
