import type { SqliteDb } from '../db/sqlite'
import type { NexusProvider } from './types'
import { NexusCache } from './cache'
import { MockNexusProvider } from './mockProvider'
import { HttpNexusProvider } from './httpProvider'

export type { NexusProvider, NexusModMeta, NexusFile, UpdateCheck } from './types'
export { NexusCache } from './cache'
export { MockNexusProvider } from './mockProvider'
export { HttpNexusProvider } from './httpProvider'

export interface NexusConfig {
  /** Feature flag — defaults to the NEXUS_ENABLED env var. */
  enabled?: boolean
  /** API key — defaults to NEXUS_API_KEY env var; prefer the OS-encrypted store. */
  apiKey?: string | null
}

// Deferred activation: with no key / NEXUS_ENABLED!=true the MOCK provider is
// returned so the app stays fully functional offline. Supply the key + flag and
// the HTTP provider activates automatically — no architectural change.
export function createNexusProvider(db: SqliteDb, cfg: NexusConfig = {}): NexusProvider {
  const enabled = cfg.enabled ?? process.env.NEXUS_ENABLED === 'true'
  const apiKey = cfg.apiKey ?? process.env.NEXUS_API_KEY ?? null
  if (enabled && apiKey && apiKey.trim().length >= 8) {
    return new HttpNexusProvider(apiKey, new NexusCache(db))
  }
  return new MockNexusProvider()
}
