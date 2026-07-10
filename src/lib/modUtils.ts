// Shared mod-list helpers, single-sourced so the compatibility analyzer, the launch
// workflow and the UI gauge agree on the same numbers and the same parsing rule.

/** Skyrim SE/AE hard cap on active full ESP/ESM plugins (ESL / ESL-flagged excluded). */
export const LOAD_ORDER_LIMIT = 254
/** "Getting close" threshold before the hard cap — surfaces a warning, not an error. */
export const LOAD_ORDER_WARN = 220

/** Parse a mod's JSON `requires` field into a string[]; tolerant of null/invalid input. */
export function parseRequires(s: string | null | undefined): string[] {
  try {
    return JSON.parse(s || '[]') as string[]
  } catch {
    return []
  }
}
