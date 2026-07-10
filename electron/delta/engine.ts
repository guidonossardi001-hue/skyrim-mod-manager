import { ipcMain } from 'electron'
import type { SqliteDb } from '../db/sqlite'
import { DeltaService } from './service'
import { onDeltaDownloadComplete, onDeltaDownloadFailed } from './hooks'
import { pinnedPublicKey } from './pinnedKey'
import { fetchSignedManifest, DEFAULT_MANIFEST_HOSTS } from './fetchCatalog'
import { logger } from '../logger'

function manifestHosts(): string[] {
  const env = process.env.NOLVUS_CATALOG_HOSTS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return env && env.length ? env : DEFAULT_MANIFEST_HOSTS
}

let service: DeltaService | null = null

export function initDeltaEngine(db: SqliteDb, deps: { enqueueDownload: (downloadId: number) => void }) {
  service = new DeltaService(db, {
    publicKeyPem: pinnedPublicKey(),
    enqueueDownload: deps.enqueueDownload,
    log: (level, msg) => (level === 'warn' ? logger.warn('delta', msg) : logger.info('delta', msg)),
  })

  ipcMain.handle('delta:ingest', (_e, signed: unknown) => service!.ingest(signed as never))
  // Act-03: fetch the signed catalog over real HTTPS (host-allow-listed, fail-closed)
  // then run it through the SAME trust boundary as a bundled manifest.
  ipcMain.handle('delta:ingest-url', async (_e, url: string) => {
    try {
      const signed = await fetchSignedManifest(url, { allowedHosts: manifestHosts() })
      const res = service!.ingest(signed)
      if (res.success)
        logger.info(
          'delta',
          `catalogo remoto ingerito da ${url} (release ${res.releaseId}${res.reused ? ', riusato' : ''})`,
        )
      return res
    } catch (e) {
      logger.warn('delta', `ingest-url rifiutato: ${(e as Error).message}`)
      return { success: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('delta:sync-snapshot', (_e, profileId: number) => service!.syncSnapshot(profileId))
  ipcMain.handle('delta:check-updates', (_e, profileId: number) => service!.checkUpdates(profileId))
  ipcMain.handle('delta:check', (_e, profileId: number) => service!.check(profileId))
  ipcMain.handle('delta:list', (_e, profileId: number, toReleaseId: number) =>
    service!.list(profileId, toReleaseId),
  )
  ipcMain.handle('delta:apply', (_e, profileId: number, toReleaseId: number) =>
    service!.apply(profileId, toReleaseId),
  )
  ipcMain.handle('delta:finalize', (_e, profileId: number, toReleaseId: number) =>
    service!.finalize(profileId, toReleaseId),
  )
  ipcMain.handle('delta:recover', () => service!.recover())
}

export { onDeltaDownloadComplete, onDeltaDownloadFailed }
