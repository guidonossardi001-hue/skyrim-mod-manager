// Pure derivation of a plausible plugin (.esm/.esp/.esl) load order from the
// installed mod set. Used both by the Plugins page (drag-order UI) and the
// Compatibility report (plugin classification fallback when no real plugins.txt
// is available, e.g. the browser preview). No DOM, no store — fully testable.
import type { Mod } from '@/types'

export interface Plugin {
  id: string
  name: string
  type: 'ESM' | 'ESP' | 'ESL'
  enabled: boolean
  modName: string
  loadIndex: number
  isMaster: boolean
  hasWarning?: boolean
}

const KNOWN_PLUGINS: { modKeyword: string; plugins: { name: string; type: 'ESM' | 'ESP' | 'ESL' }[] }[] = [
  { modKeyword: 'skse', plugins: [{ name: 'SKSE64', type: 'ESM' }] },
  { modKeyword: 'skyui', plugins: [{ name: 'SkyUI_SE.esp', type: 'ESP' }] },
  { modKeyword: 'cbbe', plugins: [{ name: 'CBBE.esp', type: 'ESP' }] },
  { modKeyword: 'ordinator', plugins: [{ name: 'Ordinator - Perks of Skyrim.esp', type: 'ESP' }] },
  { modKeyword: 'apocalypse', plugins: [{ name: 'Apocalypse - Magic of Skyrim.esp', type: 'ESP' }] },
  { modKeyword: 'odin', plugins: [{ name: 'Odin - Skyrim Magic Overhaul.esp', type: 'ESP' }] },
  { modKeyword: 'inigo', plugins: [{ name: 'Inigo.esp', type: 'ESP' }] },
  { modKeyword: 'lucien', plugins: [{ name: 'Lucien.esp', type: 'ESP' }] },
  { modKeyword: 'valhalla', plugins: [{ name: 'Valhalla Combat.esp', type: 'ESP' }] },
  { modKeyword: 'precision', plugins: [{ name: 'Precision.esp', type: 'ESL' }] },
  { modKeyword: 'truehud', plugins: [{ name: 'TrueHUD.esp', type: 'ESL' }] },
  { modKeyword: 'scar', plugins: [{ name: 'SCAR.esp', type: 'ESL' }] },
  { modKeyword: 'ostim', plugins: [{ name: 'OStim.esp', type: 'ESM' }] },
  { modKeyword: 'ks hairdos', plugins: [{ name: 'KS Hairdos.esp', type: 'ESP' }] },
  { modKeyword: 'wintersun', plugins: [{ name: 'Wintersun - Faiths of Skyrim.esp', type: 'ESP' }] },
  { modKeyword: 'mysticism', plugins: [{ name: 'Mysticism - A Magic Overhaul.esp', type: 'ESP' }] },
  { modKeyword: 'jk', plugins: [{ name: "JK's Skyrim.esp", type: 'ESP' }] },
  { modKeyword: 'helgen reborn', plugins: [{ name: 'Helgen Reborn.esp', type: 'ESP' }] },
]

export function derivePluginsFromMods(mods: Mod[]): Plugin[] {
  const plugins: Plugin[] = []
  const enabled = mods.filter((m) => m.is_enabled && m.is_installed)
  let loadIndex = 0

  // Always-present base game masters
  const baseMasters: Plugin[] = [
    {
      id: 'skyrim',
      name: 'Skyrim.esm',
      type: 'ESM',
      enabled: true,
      modName: 'Base Game',
      loadIndex: loadIndex++,
      isMaster: true,
    },
    {
      id: 'update',
      name: 'Update.esm',
      type: 'ESM',
      enabled: true,
      modName: 'Base Game',
      loadIndex: loadIndex++,
      isMaster: true,
    },
    {
      id: 'dawnguard',
      name: 'Dawnguard.esm',
      type: 'ESM',
      enabled: true,
      modName: 'DLC',
      loadIndex: loadIndex++,
      isMaster: true,
    },
    {
      id: 'hearthfires',
      name: 'HearthFires.esm',
      type: 'ESM',
      enabled: true,
      modName: 'DLC',
      loadIndex: loadIndex++,
      isMaster: true,
    },
    {
      id: 'dragonborn',
      name: 'Dragonborn.esm',
      type: 'ESM',
      enabled: true,
      modName: 'DLC',
      loadIndex: loadIndex++,
      isMaster: true,
    },
  ]
  plugins.push(...baseMasters)

  for (const mod of enabled) {
    const lname = mod.name.toLowerCase()
    const matched = KNOWN_PLUGINS.filter((kp) => lname.includes(kp.modKeyword))
    for (const kp of matched) {
      for (const p of kp.plugins) {
        plugins.push({
          id: `${mod.id}-${p.name}`,
          name: p.name,
          type: p.type,
          enabled: true,
          modName: mod.name,
          loadIndex: loadIndex++,
          isMaster: p.type === 'ESM',
        })
      }
    }
    // Generic plugin for mods without a known mapping
    if (matched.length === 0) {
      const safeName = mod.name.replace(/[^a-zA-Z0-9 ]/g, '').trim()
      if (safeName) {
        plugins.push({
          id: `${mod.id}-generic`,
          name: `${safeName}.esp`,
          type: 'ESP',
          enabled: true,
          modName: mod.name,
          loadIndex: loadIndex++,
          isMaster: false,
        })
      }
    }
  }

  return plugins
}
