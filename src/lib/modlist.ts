// Pure, side-effect-free helpers for parsing external mod-manager files.
// Kept separate from the store so they can be unit-tested without a DOM/Electron.

export interface ParsedModlistEntry {
  name: string
  enabled: boolean
}

/**
 * Parse a Mod Organizer 2 `modlist.txt`.
 * Each line is `+Name` (enabled), `-Name` (disabled) or `*Name` (separator/managed).
 * Lines starting with `#` are comments; blank lines are ignored.
 * MO2 writes the list bottom-up (lowest priority first); callers decide ordering.
 */
export function parseMO2Modlist(content: string): ParsedModlistEntry[] {
  const out: ParsedModlistEntry[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const enabled = line.startsWith('+')
    const name = line.replace(/^[+\-*]/, '').trim()
    if (!name) continue
    out.push({ name, enabled })
  }
  return out
}
