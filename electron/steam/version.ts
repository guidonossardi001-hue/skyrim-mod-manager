// Pure version helpers for Skyrim runtime + SKSE compatibility (T5). Unit-tested.
// Strategy without parsing the PE header: the Address Library bin filename encodes
// the exact game runtime (version-1-6-1170-0.bin) and the SKSE runtime DLL encodes
// the game build it targets (skse64_1_6_1170.dll). A match on the first three
// components means SKSE is compatible with the installed runtime.

/** "version-1-6-1170-0.bin" → "1.6.1170.0" */
export function parseAddressLibVersion(filename: string): string | null {
  const m = filename.match(/^version-([\d-]+)\.bin$/i)
  return m ? m[1].replace(/-/g, '.') : null
}

/** "skse64_1_6_1170.dll" → "1.6.1170" (the game build SKSE targets) */
export function parseSkseRuntimeVersion(filename: string): string | null {
  const m = filename.match(/^skse64_(\d+)_(\d+)_(\d+)\.dll$/i)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

function toTriple(v: string | null): number[] {
  return (String(v ?? '').match(/\d+/g) ?? []).slice(0, 3).map((n) => parseInt(n, 10))
}

/**
 * true  = SKSE build matches the game runtime (first 3 components)
 * false = mismatch (SKSE for a different game build → would refuse to load)
 * null  = cannot determine (missing data) — caller treats as "ok" (no spurious block)
 */
export function gameVersionSupported(
  gameVersion: string | null,
  skseRuntimeVersion: string | null,
): boolean | null {
  if (!gameVersion || !skseRuntimeVersion) return null
  const g = toTriple(gameVersion)
  const s = toTriple(skseRuntimeVersion)
  if (g.length < 3 || s.length < 3) return null
  for (let i = 0; i < 3; i++) if ((g[i] ?? 0) !== (s[i] ?? 0)) return false
  return true
}
