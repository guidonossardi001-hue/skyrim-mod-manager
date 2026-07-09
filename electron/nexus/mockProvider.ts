import type { NexusProvider, NexusModMeta, NexusFile, UpdateCheck } from './types'
import { isNewer } from '../delta/version'

// Offline/demo provider — keeps the app fully functional without a Nexus key and
// backs the test-suite. Deterministic canned data, no network.

const DATA: Record<number, { meta: NexusModMeta; files: NexusFile[] }> = {
  17230: {
    meta: {
      mod_id: 17230,
      name: 'SKSE64 – Skyrim Script Extender',
      summary: 'Script extender',
      version: '2.2.6',
      author: 'ianpatt',
      category: 'framework',
      endorsement: 'Undecided',
      updated_timestamp: 1700000000,
      available: true,
    },
    files: [{ file_id: 430000, name: 'skse64', version: '2.2.6', size: 5 * 1024 * 1024, category: 'MAIN' }],
  },
  1137: {
    meta: {
      mod_id: 1137,
      name: 'SkyUI',
      summary: 'UI overhaul',
      version: '5.3SE',
      author: 'schlangster',
      category: 'ui',
      endorsement: 'Endorsed',
      updated_timestamp: 1690000000,
      available: true,
    },
    files: [
      { file_id: 120001, name: 'SkyUI_5_3', version: '5.3SE', size: 8 * 1024 * 1024, category: 'MAIN' },
    ],
  },
  32444: {
    meta: {
      mod_id: 32444,
      name: 'Address Library for SKSE Plugins',
      summary: 'Address library',
      version: '5.0',
      author: 'meh321',
      category: 'framework',
      endorsement: 'Endorsed',
      updated_timestamp: 1695000000,
      available: true,
    },
    files: [
      { file_id: 88001, name: 'AddressLibrary', version: '5.0', size: 10 * 1024 * 1024, category: 'MAIN' },
    ],
  },
}

export class MockNexusProvider implements NexusProvider {
  readonly kind = 'mock' as const
  readonly enabled = true

  async getMod(modId: number): Promise<NexusModMeta | null> {
    return DATA[modId]?.meta ?? null
  }
  async searchByName(query: string): Promise<NexusModMeta[]> {
    const q = query.toLowerCase()
    return Object.values(DATA)
      .map((d) => d.meta)
      .filter((m) => m.name.toLowerCase().includes(q))
  }
  async getFiles(modId: number): Promise<NexusFile[]> {
    return DATA[modId]?.files ?? []
  }
  async getLatestVersion(modId: number): Promise<string | null> {
    return DATA[modId]?.meta.version ?? null
  }
  async checkUpdate(modId: number, currentVersion: string | null): Promise<UpdateCheck> {
    const latest = await this.getLatestVersion(modId)
    return {
      mod_id: modId,
      current: currentVersion,
      latest,
      hasUpdate: !!latest && isNewer(latest, currentVersion),
    }
  }
}
