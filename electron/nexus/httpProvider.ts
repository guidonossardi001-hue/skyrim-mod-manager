import axios, { type AxiosRequestConfig } from 'axios'
import type { NexusProvider, NexusModMeta, NexusFile, UpdateCheck } from './types'
import type { NexusCache } from './cache'
import { isNewer } from '../delta/version'

const BASE = 'https://api.nexusmods.com/v1/games/skyrimspecialedition'
const UA = 'SkyrimAEModManager/1.0'

// Real Nexus provider. Active only when constructed by the factory (NEXUS_ENABLED
// + key). Uses the SQLite cache with ETag revalidation, retries with backoff on
// rate-limit (429), and falls back to STALE cache on any network error (offline).

export class HttpNexusProvider implements NexusProvider {
  readonly kind = 'http' as const
  readonly enabled = true
  constructor(
    private apiKey: string,
    private cache: NexusCache,
    private ttlMs = 6 * 60 * 60 * 1000,
  ) {}

  private async fetch(path: string): Promise<unknown | null> {
    const fresh = this.cache.get(path)
    if (fresh) return JSON.parse(fresh.body)
    const stale = this.cache.getStale(path)
    const cfg: AxiosRequestConfig = {
      headers: {
        apikey: this.apiKey,
        'User-Agent': UA,
        ...(stale?.etag ? { 'If-None-Match': stale.etag } : {}),
      },
      timeout: 15000,
      validateStatus: (s) => s === 200 || s === 304 || s === 429,
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios.get(`${BASE}${path}`, cfg)
        if (res.status === 304 && stale) {
          this.cache.touch(path)
          return JSON.parse(stale.body)
        }
        if (res.status === 429) {
          await delay(1000 * (attempt + 1))
          continue
        } // rate limited → backoff
        const etag = (res.headers['etag'] as string) ?? null
        this.cache.set(path, JSON.stringify(res.data), etag, this.ttlMs)
        return res.data
      } catch {
        if (stale) return JSON.parse(stale.body) // offline → serve stale
        return null
      }
    }
    return stale ? JSON.parse(stale.body) : null
  }

  async getMod(modId: number): Promise<NexusModMeta | null> {
    const d = (await this.fetch(`/mods/${modId}.json`)) as Record<string, unknown> | null
    if (!d) return null
    return {
      mod_id: modId,
      name: String(d.name ?? ''),
      summary: (d.summary as string) ?? null,
      version: (d.version as string) ?? null,
      author: (d.author as string) ?? null,
      category: d.category_id != null ? String(d.category_id) : null,
      endorsement: (d.endorsement as { endorse_status?: string })?.endorse_status ?? null,
      updated_timestamp: (d.updated_timestamp as number) ?? null,
      available: d.available !== false,
    }
  }

  async getFiles(modId: number): Promise<NexusFile[]> {
    const d = (await this.fetch(`/mods/${modId}/files.json`)) as { files?: Record<string, unknown>[] } | null
    if (!d?.files) return []
    return d.files.map((f) => ({
      file_id: Number(f.file_id),
      name: String(f.name ?? ''),
      version: (f.version as string) ?? null,
      size: Number(f.size_in_bytes ?? f.size ?? 0),
      category: (f.category_name as string) ?? null,
    }))
  }

  async searchByName(_query: string): Promise<NexusModMeta[]> {
    // The public Nexus API has no general name-search endpoint; returning [] keeps
    // the contract total. Name search is served by the catalog locally instead.
    return []
  }

  async getLatestVersion(modId: number): Promise<string | null> {
    return (await this.getMod(modId))?.version ?? null
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
