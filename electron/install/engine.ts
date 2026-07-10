import type { SqliteDb } from '../db/sqlite'
import { InstallerService, defaultExtractor, sweepStaging, recoverReinstalls } from './installer'

// Install engine: owns the single InstallerService instance and the boot-time
// staging sweep. Mirrors delta/engine.ts and catalog/engine.ts (service factory +
// lifecycle). The queue/DB/event/IPC glue lives in installManager.ts, which
// consumes the service exposed here — so there is exactly one InstallerService and
// no duplicated `install:run` registration.

export interface InstallEngineOptions {
  db: SqliteDb
  modsRoot: () => string
  sevenZipPath?: () => string | null | undefined // configured system 7-Zip (for .rar)
  log?: (level: 'info' | 'warn', msg: string) => void
}

export function initInstallEngine(opts: InstallEngineOptions): InstallerService {
  const service = new InstallerService({
    db: opts.db,
    modsRoot: opts.modsRoot,
    // Re-resolve the configured 7-Zip path per call so a Settings change needs no restart.
    extract: (req) => defaultExtractor(opts.sevenZipPath?.())(req),
    log: opts.log,
  })

  // Discard any .staging dirs orphaned by a crash mid-install in a prior session.
  const swept = sweepStaging(opts.modsRoot())
  if (swept) opts.log?.('info', `staging orfani rimossi al boot: ${swept}`)

  // Recover any reinstall interrupted mid-swap (restore or discard the .smm-old backup).
  const recovered = recoverReinstalls(opts.modsRoot())
  if (recovered) opts.log?.('info', `reinstallazioni interrotte recuperate al boot: ${recovered}`)

  return service
}

export { sweepStaging, recoverReinstalls }
