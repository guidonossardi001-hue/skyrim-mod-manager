// Shared filesystem-path helpers. Centralised so the ONE rule that turns a mod /
// profile / file display name into a safe path segment lives in a single place —
// the code that writes a path and the code that later matches it can never drift.

import { join } from 'path'

/**
 * Absolute path to the real Windows PowerShell — invoking it by bare name would let a
 * planted powershell.exe on PATH/cwd run instead of the real one (binary-planting), same
 * mitigation as electron/steam/detect.ts's REG_EXE/TASKLIST_EXE. Shared by every module
 * that shells out to PowerShell (hardwareInfo.ts, pagefileCheck.ts, dialogWatcher.ts) so
 * the resolution logic lives in exactly one place.
 */
export function resolvePowerShellExe(): string {
  const sys32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
  return join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// Windows reserved device names: a path segment equal to one of these (optionally
// with an extension) resolves to a DEVICE, not a file, on Windows.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i

/**
 * Reduce an arbitrary display string to a single NTFS-safe path segment: replace the
 * Windows-reserved characters `< > : " / \ | ? *` with `_`, collapse whitespace to one
 * space, trim, strip trailing dots/spaces, and cap at 120 chars. Rejects navigation
 * segments ("." / "..") and reserved device names — returning `fallback` — so a
 * renderer-supplied profile/mod name can never become a one-level directory escape.
 */
export function sanitizePathSegment(name: string, fallback = 'mod'): string {
  const cleaned = String(name)
    // Windows-reserved characters -> '_'. Whitespace (incl. newlines/tabs) is collapsed
    // to one space by the next step, so a raw newline in a name can't split a path.
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    // Windows silently strips trailing dots/spaces ("foo." -> "foo"), which would let a
    // crafted name mask a reserved name or collide with a sibling; strip them ourselves.
    .replace(/[ .]+$/g, '')
  // Reject navigation segments ("." / "..", e.g. join(root, "..") escapes root) and
  // reserved device names outright.
  if (!cleaned || cleaned === '.' || cleaned === '..' || WIN_RESERVED.test(cleaned)) return fallback
  return cleaned
}
