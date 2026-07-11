// Texture Profile selector for the mass-installer. Many mods ship the SAME modId in multiple
// resolutions (e.g. modId 183 = file 276958 "…(CBBE) 4K" + file 276959 "…(CBBE) 2K"); the Vortex
// backup's `deduped` list keeps only one. This module reconstructs the resolution VARIANTS from
// the raw file list and, given a user profile ('2K' | '4K'), selects the matching file — with a
// graceful fallback when the exact resolution is missing, so an install never fails for lack of a
// 2K. Pure & side-effect-free so both the URL/fileId selection AND the disk-space estimate are
// unit-testable in isolation.

/** User-facing quality setting. */
export type TextureProfile = '2K' | '4K'
export const TEXTURE_PROFILES: readonly TextureProfile[] = ['2K', '4K']
export const DEFAULT_TEXTURE_PROFILE: TextureProfile = '4K'

/** Any resolution a mod file may carry (superset of the user profiles). */
export type Resolution = '1K' | '2K' | '4K' | '8K'

export interface TextureVariant {
  resolution: Resolution
  fileId: number
  name: string
  md5?: string
  fileSize?: number
}

/** The minimal file shape the selector reads/writes (structural — SyncMod satisfies it). */
export interface ModFile {
  modId: number
  fileId: number
  name: string
  md5?: string
  fileSize?: number
  variants?: TextureVariant[]
}

export function isTextureProfile(v: unknown): v is TextureProfile {
  return v === '2K' || v === '4K'
}

/** Parse a resolution tag (1K/2K/4K/8K, case-insensitive) out of a file/mod name, or null. */
export function parseResolution(name: string | null | undefined): Resolution | null {
  if (typeof name !== 'string') return null
  const m = name.match(/\b([1248])\s?k\b/i)
  return m ? ((m[1] + 'K') as Resolution) : null
}

/**
 * Build the resolution-variant set for ONE mod from its raw files (all sharing a modId). Only
 * files whose NAME carries a resolution tag become variants; the first file seen per resolution
 * wins. Mods without any resolution-tagged file get no variants (they download normally).
 */
export function buildVariants(
  rawFiles: Array<{ fileId: number; name: string; md5?: string; fileSize?: number }>,
): TextureVariant[] {
  const byRes = new Map<Resolution, TextureVariant>()
  for (const f of rawFiles) {
    const res = parseResolution(f.name)
    if (!res || byRes.has(res)) continue
    byRes.set(res, { resolution: res, fileId: f.fileId, name: f.name, md5: f.md5, fileSize: f.fileSize })
  }
  return [...byRes.values()]
}

// Fallback order per profile: prefer the requested resolution, then the nearest sensible
// alternative. '2K' (save space) steps DOWN to 1K before going heavier; '4K' (quality) prefers
// the requested, then the lighter 2K, then heavier 8K, then 1K.
const FALLBACK: Record<TextureProfile, Resolution[]> = {
  '2K': ['2K', '1K', '4K', '8K'],
  '4K': ['4K', '2K', '8K', '1K'],
}

/**
 * Resolve a mod to the file matching the profile. If the mod has variants, pick the first
 * available resolution in the profile's fallback order; otherwise keep the mod's base file
 * (texture-only mods without variants download unchanged). Returns a NEW object with the chosen
 * fileId/name/md5/fileSize; `modId` and `variants` are preserved.
 */
export function selectVariant<T extends ModFile>(mod: T, profile: TextureProfile): T {
  const variants = mod.variants
  if (variants && variants.length) {
    for (const res of FALLBACK[profile]) {
      const v = variants.find((x) => x.resolution === res)
      if (v) return { ...mod, fileId: v.fileId, name: v.name, md5: v.md5, fileSize: v.fileSize }
    }
  }
  return mod
}

/** Resolve a whole list to the given profile (used before the preflight and the download loop). */
export function resolveMods<T extends ModFile>(mods: T[], profile: TextureProfile): T[] {
  return mods.map((m) => selectVariant(m, profile))
}
