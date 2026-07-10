import { ipcMain } from 'electron'
import type { SqliteDb } from '../db/sqlite'
import { CatalogService } from './service'
import { pinnedPublicKey } from '../delta/pinnedKey'
import { fetchSignedCatalog, resolveModCatalogUrl, DEFAULT_MOD_CATALOG_HOSTS } from './fetch'
import { resolveInstallPlan, type InstallPlanResult } from './dependencies'
import { logger } from '../logger'
import type { CatalogIngestResult } from './types'

// Thin ipcMain wrapper around CatalogService, same shape as ../delta/engine.ts.
// Reuses the SAME pinned Ed25519 key as the delta manifest — one root of trust
// for every signed artifact this project publishes. If the reference catalog is
// ever signed by a different key, add a second pinned constant and pass it here.

function catalogHosts(): string[] {
  const env = process.env.NOLVUS_MOD_CATALOG_HOSTS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return env && env.length ? env : DEFAULT_MOD_CATALOG_HOSTS
}

let service: CatalogService | null = null

export function initCatalogEngine(db: SqliteDb) {
  service = new CatalogService(db, {
    publicKeyPem: pinnedPublicKey(),
    log: (level, msg) => (level === 'warn' ? logger.warn('catalog', msg) : logger.info('catalog', msg)),
  })

  // catalog:update = fetch (network, may fail) → ingest (verify+validate+commit,
  // already no-throw). Every path returns a CatalogIngestResult — nothing thrown
  // across the IPC boundary, ever.
  ipcMain.handle('catalog:update', async (_e, url?: string): Promise<CatalogIngestResult> => {
    const target = resolveModCatalogUrl(url)
    if (!target) {
      logger.warn('catalog', 'catalog:update: nessun URL configurato (NOLVUS_MOD_CATALOG_URL)')
      return { success: false, errorKind: 'network', error: 'URL catalogo non configurato' }
    }

    let signed
    try {
      signed = await fetchSignedCatalog(target, { allowedHosts: catalogHosts() })
    } catch (e) {
      logger.warn('catalog', `fetch catalogo fallito: ${(e as Error).message}`)
      return { success: false, errorKind: 'network', error: (e as Error).message }
    }

    try {
      const res = service!.ingest(signed)
      if (res.success)
        logger.info(
          'catalog',
          `catalogo remoto ingerito da ${target} (v${res.version}${res.reused ? ', riusato' : ''})`,
        )
      return res
    } catch (e) {
      // Defense-in-depth: ingest() is already no-throw by contract, but an
      // unexpected error from a dependency must still not cross the IPC boundary.
      logger.warn('catalog', `catalog:update fallito inatteso: ${(e as Error).message}`)
      return { success: false, errorKind: 'db', error: (e as Error).message }
    }
  })

  // catalog:resolve-plan = pure dependency resolution against the loaded catalog.
  // resolveInstallPlan is already a no-throw boundary; the extra try/catch here is
  // defense-in-depth so a low-level failure (DB locked, native crash) still returns
  // a Result with errorKind 'db' instead of rejecting the IPC call.
  ipcMain.handle(
    'catalog:resolve-plan',
    (_e, targetNexusIds: number[], installedNexusIds: number[]): InstallPlanResult => {
      try {
        return resolveInstallPlan(db, targetNexusIds ?? [], installedNexusIds ?? [])
      } catch (e) {
        logger.warn('catalog', `resolve-plan fallito inatteso: ${(e as Error).message}`)
        return { success: false, errorKind: 'db', errors: [(e as Error).message] }
      }
    },
  )
}
