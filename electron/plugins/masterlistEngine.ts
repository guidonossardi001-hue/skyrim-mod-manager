import { ipcMain } from 'electron'
import { refreshMasterlistCache, loadMasterlistCache } from './masterlistCache'
import type { HttpGetText } from './lootMasterlist'

// Thin ipcMain wrapper (stesso pattern di catalog/engine.ts): masterlist:refresh fa il fetch
// ESPLICITO (mai automatico al boot — un fetch di rete silenzioso ad ogni avvio è la stessa
// classe di bug del vecchio auto-seed, vedi [[skyrim-catalog-wiped]]); masterlist:status legge
// SOLO la cache locale, mai la rete.

export interface MasterlistEngineOptions {
  resolveCachePath: () => string
  http: HttpGetText
  nowIso: () => string
  log?: (level: 'info' | 'warn', msg: string) => void
}

export function initMasterlistEngine(opts: MasterlistEngineOptions) {
  ipcMain.handle('masterlist:refresh', async () => {
    try {
      const cache = await refreshMasterlistCache(opts.http, opts.resolveCachePath(), { nowIso: opts.nowIso() })
      opts.log?.(
        'info',
        `masterlist LOOT aggiornato: ${cache.pluginCount} plugin, ${cache.rules.length} regole after, ${cache.dirty.length} entry dirty`,
      )
      return {
        ok: true as const,
        pluginCount: cache.pluginCount,
        groupCount: cache.groupCount,
        ruleCount: cache.rules.length,
        dirtyCount: cache.dirty.length,
        fetchedAt: cache.fetchedAt,
      }
    } catch (e) {
      opts.log?.('warn', `masterlist:refresh fallito: ${(e as Error).message}`)
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('masterlist:status', () => {
    const cache = loadMasterlistCache(opts.resolveCachePath())
    if (!cache) return { ok: true as const, cached: false as const }
    return {
      ok: true as const,
      cached: true as const,
      pluginCount: cache.pluginCount,
      groupCount: cache.groupCount,
      ruleCount: cache.rules.length,
      dirtyCount: cache.dirty.length,
      fetchedAt: cache.fetchedAt,
    }
  })
}
