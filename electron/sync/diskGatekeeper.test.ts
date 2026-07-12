import { describe, it, expect } from 'vitest'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import {
  computeRequiredSpace,
  computeDiskGate,
  decideDiskGate,
  DISK_BUFFER_FACTOR,
  type RequiredSpace,
} from './diskGatekeeper'
import { modDestDir, stockGameModsDir, type SyncMod } from './massSync'
import { selectVariant } from './textureProfile'

// Sizing catalog: Alpha (100), Beta framework (50, a dependency of Alpha), Gamma (variants 2K/4K).
const MODS: SyncMod[] = [
  { modId: 1, fileId: 11, name: 'Alpha', fileSize: 100 },
  { modId: 2, fileId: 21, name: 'Beta Framework', fileSize: 50 },
  {
    modId: 3,
    fileId: 31,
    name: 'Gamma',
    fileSize: 200,
    variants: [
      { resolution: '4K', fileId: 34, name: 'Gamma-4K.7z', fileSize: 200 },
      { resolution: '2K', fileId: 32, name: 'Gamma-2K.7z', fileSize: 80 },
    ],
  },
]

// A catalog where Alpha (1) REQUIRES Beta (2); Gamma (3) stands alone.
function catalogDb(rows: Array<{ id: number; name: string; requires?: number[] }>): SqliteDb {
  const db = openTestDb()
  applyPragmas(db)
  db.exec(`CREATE TABLE modlist_catalog (
    nexus_id INTEGER PRIMARY KEY, name TEXT, priority_order INTEGER,
    requires TEXT, conflicts_with TEXT)`)
  const ins = db.prepare(
    'INSERT INTO modlist_catalog (nexus_id, name, priority_order, requires, conflicts_with) VALUES (?,?,?,?,?)',
  )
  rows.forEach((r, i) => ins.run(r.id, r.name, i, JSON.stringify(r.requires ?? []), '[]'))
  return db
}

const noneInstalled = () => false

describe('computeRequiredSpace — dependency-expanded footprint', () => {
  it('sums the transitive plan (target + auto-pulled dependency) at 4K', () => {
    const db = catalogDb([
      { id: 1, name: 'Alpha', requires: [2] },
      { id: 2, name: 'Beta Framework' },
      { id: 3, name: 'Gamma' },
    ])
    // User selects Alpha (1) + Gamma (3) but NOT the Beta framework it requires.
    const r = computeRequiredSpace({
      db,
      mods: MODS,
      targetIds: [1, 3],
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
    })
    expect(r.usedDependencyGraph).toBe(true)
    expect(r.extraDepIds).toEqual([2]) // Beta was pulled in by the graph, not selected
    expect(r.requiredBytes).toBe(350) // 100 + 50 (dep) + 200 = the un-counted dep is now counted
    expect(r.unknownDepIds).toEqual([])
    expect(r.savingBytes).toBe(0) // 4K is the baseline
  })

  it('a 2K profile estimates the lighter variant and reports the GB saved vs 4K', () => {
    const db = catalogDb([
      { id: 1, name: 'Alpha', requires: [2] },
      { id: 2, name: 'Beta Framework' },
      { id: 3, name: 'Gamma' },
    ])
    const r = computeRequiredSpace({
      db,
      mods: MODS,
      targetIds: [1, 3],
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '2K',
    })
    expect(r.requiredBytes).toBe(230) // 100 + 50 + 80 (Gamma 2K variant)
    expect(r.requiredBytes4K).toBe(350)
    expect(r.savingBytes).toBe(120) // 350 − 230
  })

  it('excludes mods already extracted on disk', () => {
    const db = catalogDb([
      { id: 1, name: 'Alpha', requires: [2] },
      { id: 2, name: 'Beta Framework' },
      { id: 3, name: 'Gamma' },
    ])
    // Alpha already installed → its dir exists → neither Alpha nor its dep re-counted.
    const r = computeRequiredSpace({
      db,
      mods: MODS,
      targetIds: [1, 2, 3],
      stockGameDir: 'D:/SG',
      exists: (p) => p.includes('1-Alpha') || p.includes('2-Beta'),
      profile: '4K',
    })
    expect(r.plannedIds).toEqual([3])
    expect(r.requiredBytes).toBe(200)
  })

  it('surfaces a dependency with no size in the catalog instead of silently zeroing it', () => {
    // Alpha requires a Ghost dep (99) that exists in the graph but has no archive in the sizing list.
    const db = catalogDb([
      { id: 1, name: 'Alpha', requires: [99] },
      { id: 99, name: 'Ghost Dep' },
    ])
    const r = computeRequiredSpace({
      db,
      mods: MODS,
      targetIds: [1],
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
    })
    expect(r.unknownDepIds).toEqual([99])
    expect(r.requiredBytes).toBe(100) // only Alpha, the un-sizeable dep is NOT invented
  })

  it('falls back to the plain not-installed selection when there is no catalog (db null)', () => {
    const r = computeRequiredSpace({
      db: null,
      mods: MODS,
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
    })
    expect(r.usedDependencyGraph).toBe(false)
    expect(r.plannedIds.sort()).toEqual([1, 2, 3])
    expect(r.requiredBytes).toBe(350)
  })
})

describe('computeDiskGate — fail-closed queue gate', () => {
  it('passes only when free clears required × 1.15', () => {
    const g = computeDiskGate(100, 200)
    expect(g.requiredWithBuffer).toBe(Math.ceil(100 * DISK_BUFFER_FACTOR)) // 115
    expect(g.ok).toBe(true)
    expect(g.missingBytes).toBe(0)
  })

  it('BLOCKS when free is below required + 15% buffer and reports the shortfall', () => {
    const g = computeDiskGate(100, 100) // needs 115, has 100
    expect(g.ok).toBe(false)
    expect(g.missingBytes).toBe(15)
  })

  it('blocks on unreadable free space (NaN) — never fails open', () => {
    const g = computeDiskGate(100, Number.NaN)
    expect(g.ok).toBe(false)
    expect(g.missingBytes).toBeGreaterThan(0)
  })

  it('blocks on a non-finite required estimate (NaN) rather than passing', () => {
    const g = computeDiskGate(Number.NaN, 1e12)
    expect(g.ok).toBe(false)
  })

  it('an empty plan (0 required) needs no space', () => {
    const g = computeDiskGate(0, 0)
    expect(g.ok).toBe(true)
    expect(g.missingBytes).toBe(0)
  })
})

// The exact decision main.ts makes before it touches the AbortController / runMassSync: size the
// dependency-expanded plan, then gate it. These prove the gate is fail-closed AND that counting the
// pulled-in dependency is what flips a run from GO to NO-GO (the point of the resolveInstallPlan tie-in).
describe('gatekeeper composition (as wired in main) — fail-closed prevents queue start', () => {
  it('a dependency-expanded plan that exceeds free × 1.15 is NO-GO (queue must not start)', () => {
    const db = catalogDb([
      { id: 1, name: 'Alpha', requires: [2] },
      { id: 2, name: 'Beta Framework' },
    ])
    const req = computeRequiredSpace({
      db,
      mods: MODS,
      targetIds: [1], // user selected ONLY Alpha; Beta (50) is pulled in as a dependency
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
    })
    expect(req.requiredBytes).toBe(150) // Alpha 100 + dependency Beta 50
    const gate = computeDiskGate(req.requiredBytes, 160) // needs ceil(150×1.15)=173, only 160 free
    expect(gate.ok).toBe(false)
    expect(gate.missingBytes).toBe(Math.ceil(150 * 1.15) - 160)
  })

  it('the same free space WOULD have (wrongly) passed if the dependency were ignored', () => {
    // Alpha alone = 100 → ×1.15 = 115 ≤ 160 → GO. Counting the dep (→150) is what correctly blocks.
    const gate = computeDiskGate(100, 160)
    expect(gate.ok).toBe(true)
  })
})

// Hardening against the adversarial-review fail-open: an unknown/untrusted size must be treated as
// DOUBT (flagged, blocking) — never as a free 0-byte mod that silently deflates the requirement.
describe('computeRequiredSpace — untrusted sizes are doubt, not zero', () => {
  it('flags a TARGET with a missing fileSize as unsized (not summed as 0 bytes)', () => {
    const mods: SyncMod[] = [
      { modId: 1, fileId: 11, name: 'Sized', fileSize: 100 },
      { modId: 2, fileId: 21, name: 'Unsized' }, // no fileSize
    ]
    const r = computeRequiredSpace({
      db: null,
      mods,
      targetIds: [1, 2],
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
    })
    expect(r.unsizedTargetIds).toEqual([2])
    expect(r.requiredBytes).toBe(100) // the unsized mod is NOT counted as 0 and hidden
  })

  it('treats a NEGATIVE fileSize as unknown, not as a credit that lowers the total', () => {
    const mods: SyncMod[] = [
      { modId: 1, fileId: 11, name: 'Big', fileSize: 200 },
      { modId: 2, fileId: 21, name: 'Poison', fileSize: -190 }, // untrusted backup
    ]
    const r = computeRequiredSpace({
      db: null,
      mods,
      targetIds: [1, 2],
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
    })
    expect(r.requiredBytes).toBe(200) // the negative did NOT subtract from the estimate
    expect(r.unsizedTargetIds).toEqual([2])
  })

  it('detects an install by its PROFILE-VARIANT dir (2K), not the base name', () => {
    const resolved2K = selectVariant(MODS[2], '2K') // Gamma → its 2K variant file name
    const installedDir = modDestDir(stockGameModsDir('D:/SG'), resolved2K)
    const r = computeRequiredSpace({
      db: null,
      mods: [MODS[2]],
      targetIds: [3],
      stockGameDir: 'D:/SG',
      exists: (p) => p === installedDir, // only the 2K-variant dir exists
      profile: '2K',
    })
    expect(r.plannedIds).toEqual([]) // recognized as installed → nothing to re-download
  })

  it('reserves the Phase-B ITA translation footprint for a translated target', () => {
    const mods: SyncMod[] = [
      { modId: 1, fileId: 11, name: 'Base', fileSize: 100 },
      { modId: 500, fileId: 51, name: 'Base ITA', fileSize: 30 }, // translation archive
    ]
    const r = computeRequiredSpace({
      db: null,
      mods,
      targetIds: [1], // only the base is a target; the translation is applied as Phase B
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
      translationIdOf: (id) => (id === 1 ? 500 : null),
    })
    expect(r.requiredBytes).toBe(130) // base 100 + ITA translation 30
    expect(r.translationBytes).toBe(30)
  })
})

describe('decideDiskGate — unified fail-closed decision', () => {
  const GB = 1024 ** 3
  const req = (over: Partial<RequiredSpace>): RequiredSpace => ({
    targetIds: [1],
    plannedIds: [1],
    extraDepIds: [],
    unsizedTargetIds: [],
    unknownDepIds: [],
    unsizedTranslationIds: [],
    usedDependencyGraph: false,
    requiredBytes: 0,
    requiredBytes4K: 0,
    savingBytes: 0,
    translationBytes: 0,
    profile: '4K',
    ...over,
  })

  it('GO when free clears the extraction peak + 15 GB residual', () => {
    const d = decideDiskGate({ required: req({ requiredBytes: 100 * GB }), freeBytes: 400 * GB })
    expect(d.ok).toBe(true)
    expect(d.reason).toBe('ok')
    expect(d.missingBytes).toBe(0)
  })

  it("'insufficient' when the extraction model cannot fit even though the ×1.15 gate alone would", () => {
    const d = decideDiskGate({ required: req({ requiredBytes: 100 * GB }), freeBytes: 130 * GB })
    expect(d.ok).toBe(false)
    expect(d.reason).toBe('insufficient')
    // Reported required is the STRICTER model, so the message stays coherent (required > free).
    expect(d.requiredBytes).toBeGreaterThan(d.freeBytes)
    expect(d.missingBytes).toBe(d.requiredBytes - d.freeBytes)
  })

  it("'unsized' BLOCKS regardless of how much free space there is", () => {
    const d = decideDiskGate({
      required: req({ requiredBytes: 1 * GB, unsizedTargetIds: [7] }),
      freeBytes: 10_000 * GB,
    })
    expect(d.ok).toBe(false)
    expect(d.reason).toBe('unsized')
    expect(d.unsizedTargets).toEqual([7])
  })

  it("'unreadable' free space (non-finite) BLOCKS fail-closed", () => {
    const d = decideDiskGate({ required: req({ requiredBytes: 1 * GB }), freeBytes: Infinity })
    expect(d.ok).toBe(false)
    expect(d.reason).toBe('unreadable')
  })

  it('cross-disk: the downloads-cache volume must also hold the archives (+15 GB floor)', () => {
    // StockGame volume enorme, cache volume piccolo: senza il secondo probe il gate passava e la
    // cache si riempiva a metà run.
    const d = decideDiskGate({
      required: req({ requiredBytes: 100 * GB }),
      freeBytes: 4000 * GB,
      sameDisk: false,
      downloadsFreeBytes: 50 * GB,
    })
    expect(d.ok).toBe(false)
    expect(d.reason).toBe('insufficient')
    expect(d.downloadsRequiredBytes).toBeGreaterThanOrEqual(115 * GB) // archivi 100 + floor 15
    expect(d.missingBytes).toBe(d.downloadsRequiredBytes - 50 * GB)
  })

  it('cross-disk: unreadable downloads volume BLOCKS; ample cache space passes', () => {
    const blocked = decideDiskGate({
      required: req({ requiredBytes: 10 * GB }),
      freeBytes: 4000 * GB,
      downloadsFreeBytes: Infinity,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe('unreadable')
    const okD = decideDiskGate({
      required: req({ requiredBytes: 10 * GB }),
      freeBytes: 4000 * GB,
      downloadsFreeBytes: 200 * GB,
    })
    expect(okD.ok).toBe(true)
  })

  it('same-volume (downloadsFreeBytes null/omesso): nessun secondo vincolo', () => {
    const d = decideDiskGate({
      required: req({ requiredBytes: 10 * GB }),
      freeBytes: 4000 * GB,
      downloadsFreeBytes: null,
    })
    expect(d.ok).toBe(true)
    expect(d.downloadsRequiredBytes).toBe(0)
    expect(d.downloadsFreeBytes).toBeNull()
  })
})

describe('computeRequiredSpace — unsized translation surfacing', () => {
  const noneInstalled = () => false
  it('a translation with unknown size is surfaced in unsizedTranslationIds, not silently dropped', () => {
    const mods: SyncMod[] = [
      { modId: 1, fileId: 11, name: 'Base', fileSize: 100 },
      { modId: 500, fileId: 51, name: 'Base ITA' }, // translation senza fileSize
    ]
    const r = computeRequiredSpace({
      db: null,
      mods,
      targetIds: [1],
      stockGameDir: 'D:/SG',
      exists: noneInstalled,
      profile: '4K',
      translationIdOf: (id) => (id === 1 ? 500 : null),
    })
    expect(r.requiredBytes).toBe(100) // solo la base è sommabile
    expect(r.unsizedTranslationIds).toEqual([500]) // il dubbio è esposto…
    expect(r.unsizedTargetIds).toEqual([]) // …ma NON blocca (fail-soft come la Phase B stessa)
  })
})
