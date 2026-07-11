// Skyrim plugin-limit tracker. The engine loads at most 254 FULL plugins (.esp/.esm that
// occupy a normal load-order slot). A .esl file — OR a .esp/.esm carrying the ESL/"Light" flag
// (bit 0x200 in the TES4 record header) — loads into the shared FE slot and does NOT count toward
// the 254. Recognising the FLAG (not just the extension) is essential: a modlist of 3800 mods is
// only actually launchable if the count of FULL plugins stays <= 254. Pure & Electron-free (the
// header bytes / file list are injected) so the classification and the budget are unit-testable.

export type PluginKind = 'full' | 'light' | 'other'

/** ESL/Light record flag in the TES4 header (Light Master). */
export const TES4_LIGHT_FLAG = 0x0200
/** Master (ESM) record flag. */
export const TES4_MASTER_FLAG = 0x0001
/** Max FULL plugins the engine loads (index 0x00..0xFD). ESL/light live in the shared 0xFE slot. */
export const FULL_PLUGIN_LIMIT = 254

const PLUGIN_EXT = /\.(esp|esm|esl)$/i

/**
 * Read the TES4 record flags from the first bytes of a plugin. Returns null if the buffer is not a
 * TES4 record (too short / wrong magic). Layout: [0..3]='TES4', [4..7]=dataSize, [8..11]=flags(LE).
 */
export function parseTes4Flags(head: Uint8Array | null | undefined): number | null {
  if (!head || head.length < 12) return null
  if (head[0] !== 0x54 || head[1] !== 0x45 || head[2] !== 0x53 || head[3] !== 0x34) return null // 'TES4'
  return (head[8] | (head[9] << 8) | (head[10] << 16) | (head[11] << 24)) >>> 0
}

export function isLightFlagged(head: Uint8Array | null | undefined): boolean {
  const f = parseTes4Flags(head)
  return f != null && (f & TES4_LIGHT_FLAG) !== 0
}

/**
 * Classify a plugin for the 254 budget. A `.esl` is always light. A `.esp`/`.esm` is light ONLY if
 * its header carries the ESL flag (so the header bytes must be provided to detect a flagged .esp);
 * without header bytes a `.esp`/`.esm` is conservatively counted as FULL. Non-plugin files → other.
 */
export function classifyPlugin(fileName: string, head?: Uint8Array | null): PluginKind {
  const m = fileName.match(PLUGIN_EXT)
  if (!m) return 'other'
  const ext = m[1].toLowerCase()
  if (ext === 'esl') return 'light'
  return isLightFlagged(head) ? 'light' : 'full'
}

export interface PluginBudget {
  full: number // count against the 254 limit
  light: number // ESL / light-flagged (free)
  total: number // full + light
  limit: number
  overBudget: boolean
  remaining: number // limit - full (may be negative)
}

/** Aggregate a classified plugin list into the launchability budget. */
export function computePluginBudget(
  plugins: Array<{ name: string; kind: PluginKind }>,
  limit: number = FULL_PLUGIN_LIMIT,
): PluginBudget {
  let full = 0
  let light = 0
  for (const p of plugins) {
    if (p.kind === 'full') full++
    else if (p.kind === 'light') light++
  }
  return { full, light, total: full + light, limit, overBudget: full > limit, remaining: limit - full }
}
