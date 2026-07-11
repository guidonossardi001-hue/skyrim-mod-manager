import type { SqliteDb } from '../db/sqlite'

// Best-effort Italian-translation resolver for the mass-installer. A curated `mod_translation`
// table (migration v10) maps a base mod's nexus_id to its ITA translation mod/file. The resolver
// is FAIL-SOFT: no mapping (or the table absent on a pre-v10 schema) → null, and the orchestrator
// simply installs the base mod. The pure helpers below also DERIVE mappings from the Vortex backup
// (many collections already ship the ITA patch as a separate mod) so the table can be pre-populated
// without any network call; a later Nexus-discovery step can fill the gaps.

export type TranslationLang = 'it'

export interface TranslationRef {
  base_nexus_id: number
  translation_nexus_id: number
  translation_file_id: number | null
  translation_md5: string | null
}

/** Heuristic: does this mod NAME denote an Italian translation/patch (vs a base mod)? */
export function isItalianTranslation(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  const n = name.toLowerCase()
  // Markers: italian(o/a), the Italian word "traduzione", or a standalone "ita" token.
  // "translation"/"traduzione" alone are NOT enough (language-agnostic) — "French Translation" must
  // stay false. \bita\b is a whole word so "Italy"/"digital" don't match.
  return /(italiano|italiana|\bitalian\b|traduzione|\bita\b)/.test(n)
}

/** Strip the translation suffix/markers to recover the base mod name for pairing. */
export function baseNameOfTranslation(name: string): string {
  return name
    .replace(/\s*[-–—:|(]\s*(italian(?:o|a)?|traduzione(?:\s+ital\w*)?|ita)\b[\s\S]*$/i, '') // "Base - Italian Translation"
    .replace(/\s+(italiano|italiana|italian|traduzione|ita)\b[\s\S]*$/i, '') // "Base ITA" (space-separated marker)
    .replace(/\b(italiano|italiana|italian|traduzione)\b/gi, '')
    .replace(/[\s\-–—:|(]+$/, '')
    .trim()
}

/**
 * Derive ITA translation pairs from a flat mod list (e.g. the Vortex backup deduped set): match
 * each translation mod to a base mod by normalized base-name. Confident 1:1 pairs only — a
 * translation whose base name doesn't match any base mod is skipped (no guess).
 */
export function pairBackupTranslations(
  mods: Array<{ modId: number; name: string; fileId?: number; md5?: string }>,
): TranslationRef[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const baseByName = new Map<string, number>()
  for (const m of mods) {
    if (!m || typeof m.name !== 'string' || isItalianTranslation(m.name)) continue
    const key = norm(m.name)
    if (!baseByName.has(key)) baseByName.set(key, m.modId)
  }
  const out: TranslationRef[] = []
  const seenBase = new Set<number>()
  for (const m of mods) {
    if (!m || typeof m.name !== 'string' || !isItalianTranslation(m.name)) continue
    const baseKey = norm(baseNameOfTranslation(m.name))
    if (!baseKey) continue
    const baseId = baseByName.get(baseKey)
    if (baseId && baseId !== m.modId && !seenBase.has(baseId)) {
      seenBase.add(baseId)
      // Carry the translation mod's OWN fileId/md5 (from the backup entry) so it is downloadable.
      out.push({
        base_nexus_id: baseId,
        translation_nexus_id: m.modId,
        translation_file_id: m.fileId ?? null,
        translation_md5: m.md5 ?? null,
      })
    }
  }
  return out
}

/** Read the translation mapping for a base mod. Best-effort: null on no mapping / missing table. */
export function resolveTranslation(
  db: SqliteDb,
  baseNexusId: number,
  lang: TranslationLang = 'it',
): TranslationRef | null {
  try {
    const r = db
      .prepare(
        'SELECT base_nexus_id, translation_nexus_id, translation_file_id, translation_md5 FROM mod_translation WHERE base_nexus_id=? AND language=? LIMIT 1',
      )
      .get(baseNexusId, lang) as TranslationRef | undefined
    return r ?? null
  } catch {
    return null // pre-v10 schema (no table) → fail-soft
  }
}

/** Upsert derived/discovered pairs into mod_translation. Returns the number written. */
export function saveTranslations(
  db: SqliteDb,
  refs: TranslationRef[],
  source: 'backup' | 'curated' | 'nexus',
  lang: TranslationLang = 'it',
): number {
  const ins = db.prepare(
    `INSERT INTO mod_translation (base_nexus_id, language, translation_nexus_id, translation_file_id, translation_md5, source)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(base_nexus_id, language) DO UPDATE SET
       translation_nexus_id=excluded.translation_nexus_id,
       translation_file_id=excluded.translation_file_id,
       translation_md5=excluded.translation_md5,
       source=excluded.source`,
  )
  let n = 0
  for (const r of refs) {
    ins.run(r.base_nexus_id, lang, r.translation_nexus_id, r.translation_file_id ?? null, r.translation_md5 ?? null, source)
    n++
  }
  return n
}
