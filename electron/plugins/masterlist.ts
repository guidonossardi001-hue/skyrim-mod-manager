// Masterlist-lite (equivalente minimale della masterlist LOOT): regole "after" per
// plugin, lette da un JSON opzionale in userData. Parse DIFENSIVO: file assente,
// JSON rotto o forma inattesa → zero regole, mai un errore che blocchi il deploy
// (le regole sono soft anche nel sort: scartate su ciclo, mai vincolanti).
//
// Forma: { "rules": [ { "plugin": "Patch.esp", "after": ["Base.esp", ...] }, ... ] }

import { readFileSync, existsSync } from 'fs'
import type { LootRule } from './lootSort'

export const MASTERLIST_FILE = 'masterlist.json'

export function parseMasterlist(raw: string): LootRule[] {
  try {
    const data = JSON.parse(raw) as { rules?: unknown }
    if (!data || !Array.isArray(data.rules)) return []
    const rules: LootRule[] = []
    for (const r of data.rules) {
      const rule = r as { plugin?: unknown; after?: unknown }
      if (typeof rule.plugin !== 'string' || !rule.plugin.trim() || !Array.isArray(rule.after)) continue
      const after = rule.after.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      if (after.length) rules.push({ plugin: rule.plugin.trim(), after })
    }
    return rules
  } catch {
    return []
  }
}

/** Carica la masterlist dal path dato; assente/illeggibile → []. */
export function loadMasterlist(path: string | null | undefined): LootRule[] {
  if (!path) return []
  try {
    if (!existsSync(path)) return []
    return parseMasterlist(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}
