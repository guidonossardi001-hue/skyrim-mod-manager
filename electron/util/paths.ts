// Shared filesystem-path helpers. Centralised so the ONE rule that turns a mod /
// profile / file display name into a safe path segment lives in a single place —
// the code that writes a path and the code that later matches it can never drift.

/**
 * Reduce an arbitrary display string to a single NTFS-safe path segment: replace the
 * Windows-reserved characters `< > : " / \ | ? *` with `_`, collapse runs of
 * whitespace to one space, trim, and cap at 120 chars. Returns `fallback` when the
 * input reduces to empty.
 */
export function sanitizePathSegment(name: string, fallback = 'mod'): string {
  return (
    name
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || fallback
  )
}
