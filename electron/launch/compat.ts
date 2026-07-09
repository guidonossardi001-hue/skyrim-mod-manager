import type Database from 'better-sqlite3'
import type Store from 'electron-store'
import { detectSteamEnv, detectSkse } from '../steam/detect'
import { resolveMo2Plugins } from '../steam/mo2'
import { analyzeModlist, type CompatMod, type CompatAnalysis } from '../../src/lib/compatibility'

// Compatibility engine (companion mode, read-only). Assembles the modlist report
// from local sources: the real game/SKSE runtime version (T5) and the active MO2
// profile's plugins.txt (T3), then runs the pure analyzer. This is the thin glue
// the renderer's Aggiornamenti/Compatibilità pages call via `compat:analyze`.
export function runCompatReport(db: Database.Database, store: Store): CompatAnalysis {
  const { skyrim } = detectSteamEnv()
  const gamePath = skyrim.path ?? (store.get('gamePath') as string | undefined) ?? null
  const skse = detectSkse(gamePath)

  const profileId =
    (store.get('activeProfileId') as number | undefined) ??
    (
      db.prepare('SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1').get() as
        { id: number } | undefined
    )?.id ??
    1

  const rows = db
    .prepare('SELECT name, version, requires, is_enabled, category, nexus_id FROM mods WHERE profile_id=?')
    .all(profileId) as {
    name: string
    version: string | null
    requires: string | null
    is_enabled: number
    category: string | null
    nexus_id: number | null
  }[]
  const mods: CompatMod[] = rows.map((r) => ({
    name: r.name,
    version: r.version,
    requires: r.requires ?? '[]',
    is_enabled: r.is_enabled ? 1 : 0,
    category: r.category ?? 'other',
    nexus_id: r.nexus_id,
  }))

  // Real plugins.txt from the active MO2 profile (T3); empty when MO2 is absent.
  const mo2Path = (store.get('mo2Path') as string | undefined) ?? null
  const mo2 = resolveMo2Plugins(mo2Path)
  const pluginSource: CompatAnalysis['pluginSource'] = mo2.pluginsPath ? 'plugins.txt' : 'none'

  const report = analyzeModlist({ mods, plugins: mo2.plugins })
  return {
    skyrim: { version: skyrim.version, installed: skyrim.installed },
    skse: {
      present: skse.present,
      version: skse.version,
      gameVersion: skse.gameVersion,
      gameVersionSupported: skse.gameVersionSupported,
    },
    report,
    pluginSource,
    pluginCount: mo2.plugins.length,
  }
}
