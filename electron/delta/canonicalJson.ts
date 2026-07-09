// Deterministic JSON serialization for hashing/signing. Keys are sorted at every
// level and there is no insignificant whitespace, so the byte output is stable
// across processes and languages. MUST stay byte-identical to the Python signer
// (json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)).
//
// CONSTRAINT: the signed manifest MUST NOT contain floating-point numbers — JS and
// Python format floats differently. Use integers and strings only (file_id: int,
// version: string, release_counter: int). This is validated by the signer.

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}
