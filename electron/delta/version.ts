// Tolerant version comparison (fixes A6). Nexus version strings are wild:
// "1.0", "1.0.0", "v2.3a", "SE 1.5-beta", "". This comparator NEVER throws and
// gives a total ordering: numeric dotted components compared left-to-right, then
// a stable-vs-prerelease tie-break (a release with no suffix sorts ABOVE one with
// a suffix, e.g. "1.2" > "1.2-beta").

interface Parsed {
  nums: number[]
  suffix: string
}

function parse(v: unknown): Parsed {
  const s = (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().replace(/^v/i, '')
  const nums: number[] = []
  const m = s.match(/\d+/g)
  if (m) for (const n of m) nums.push(parseInt(n, 10))
  // suffix = the trailing non-numeric remainder after the last digit run
  const suffix = s.replace(/^[\d.\s]+/, '').toLowerCase()
  return { nums, suffix }
}

export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 {
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (pa.suffix === pb.suffix) return 0
  if (pa.suffix === '') return 1 // release > prerelease
  if (pb.suffix === '') return -1
  return pa.suffix < pb.suffix ? -1 : 1
}

export function isNewer(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0
}
