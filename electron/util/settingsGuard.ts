import { isAbsolute } from 'path'

// Value-level guard for settings:set (SRB-001). settings:set already validates the KEY shape
// (flat identifier, no dot-prop pollution) but writes the VALUE unchecked. Some settings are
// security-relevant PATHS: a compromised renderer that repoints them feeds filesystem resolution
// and process spawning — e.g. bootstrapper.ts builds join(gamePath,'skse64_loader.exe') and
// launcherService.launchGame spawns it, and the tool launchers spawn the *Path exe values. So the
// value for these keys must be constrained: an absolute, non-UNC, control-char-free local path.
// Pure & Electron-free so the policy is unit-testable in isolation.

export const PATH_SETTING_KEYS = new Set<string>([
  'gamePath',
  'mo2Path',
  'modsPath',
  'stockGamePath',
  'instancePath',
  'sevenZipPath',
  'lootPath',
  'sseeditPath',
  'dyndolodPath',
  'pandoraPath',
])

export type SettingWriteCheck = { ok: true } | { ok: false; reason: string }

/**
 * Decide whether a settings:set write is allowed. Non-path keys pass (they are handled/validated
 * elsewhere); a security-relevant path key must be empty (clearing is allowed) or an absolute,
 * non-UNC path with no control characters. A UNC path (\\host\share) would let a renderer mount a
 * remote/WebDAV share and have the launcher spawn a remote executable.
 */
export function validateSettingWrite(key: string, value: unknown): SettingWriteCheck {
  if (!PATH_SETTING_KEYS.has(key)) return { ok: true }
  if (value === '' || value == null) return { ok: true } // clearing a path is legitimate
  if (typeof value !== 'string') return { ok: false, reason: 'valore non stringa' }
  // Reject any control character (codepoint < 0x20) without embedding one in the source.
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return { ok: false, reason: 'caratteri di controllo non consentiti' }
  }
  if (/^\\\\/.test(value) || /^\/\//.test(value)) return { ok: false, reason: 'percorso UNC non consentito' }
  if (!isAbsolute(value)) return { ok: false, reason: 'percorso non assoluto' }
  return { ok: true }
}
