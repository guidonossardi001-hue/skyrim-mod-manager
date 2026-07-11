import { describe, it, expect, vi } from 'vitest'
import {
  assertIsolated,
  runMassSync,
  stockGameModsDir,
  modDestDir,
  filenameFromUrl,
  sanitize,
  computeDiskPreflight,
  pendingBytes,
  type MassSyncDeps,
  type SyncMod,
  type SyncProgress,
} from './massSync'
import { resolveMods } from './textureProfile'

describe('massSync: isolation guard', () => {
  it('refuses StockGame that equals / contains / is inside the Steam game', () => {
    const steam = 'C:/librearia steam/steamapps/common/Skyrim Special Edition'
    expect(() => assertIsolated(steam, steam)).toThrow(/Isolamento violato/)
    expect(() => assertIsolated(steam + '/StockGame', steam)).toThrow(/Isolamento violato/)
    expect(() => assertIsolated('C:/librearia steam/steamapps/common', steam)).toThrow(/Isolamento/)
  })
  it('accepts a separate folder, no-op when Steam path unknown', () => {
    const steam = 'C:/Steam/steamapps/common/Skyrim Special Edition'
    expect(() => assertIsolated('D:/StockGame', steam)).not.toThrow()
    expect(() => assertIsolated('D:/StockGame', null)).not.toThrow()
  })
  it('helpers', () => {
    expect(stockGameModsDir('D:/SG').replace(/\\/g, '/')).toBe('D:/SG/mods')
    expect(modDestDir('D:/SG/mods', { modId: 9, fileId: 1, name: 'A/B' }).replace(/\\/g, '/')).toBe(
      'D:/SG/mods/9-A_B',
    )
    expect(filenameFromUrl('https://cdn/x/My%20Mod-1-0.7z?a=b', 'fb')).toBe('My Mod-1-0.7z')
    expect(sanitize('A/B:C*?.7z')).toBe('A_B_C_.7z')
  })
})

interface Rec {
  active: number
  maxActive: number
}
function mkDeps(over: Partial<MassSyncDeps> = {}, rec: Rec = { active: 0, maxActive: 0 }) {
  const calls = {
    download: [] as string[],
    md5: 0,
    extract: [] as string[],
    overlay: [] as string[],
    removed: [] as string[],
    existing: new Set<string>(),
  }
  const deps: MassSyncDeps = {
    resolveLink: vi.fn(async (modId) => `https://cdn/files/${modId}.7z`),
    extractOverlay: vi.fn(async (_a, d, onP) => {
      onP(100)
      calls.overlay.push(d.replace(/\\/g, '/'))
      return { method: '7z' }
    }),
    streamDownload: vi.fn(async (_url, dest, onP) => {
      rec.active++
      rec.maxActive = Math.max(rec.maxActive, rec.active)
      onP(50, 100)
      await new Promise((r) => setTimeout(r, 4))
      onP(100, 100)
      rec.active--
      calls.download.push(dest)
      return { bytes: 100 }
    }),
    md5: vi.fn(async () => {
      calls.md5++
      return 'abc123'
    }),
    extract: vi.fn(async (_a, d, onP) => {
      onP(100)
      calls.extract.push(d)
      return { method: '7z' }
    }),
    exists: vi.fn((p: string) => calls.existing.has(p.replace(/\\/g, '/'))),
    ensureDir: vi.fn(),
    remove: vi.fn((p: string) => calls.removed.push(p.replace(/\\/g, '/'))),
    freeSpace: vi.fn(async () => 1e12), // 1 TB free by default → disk check passes
    ...over,
  }
  return { deps, calls }
}

const MODS: SyncMod[] = [
  { modId: 1, fileId: 11, name: 'Alpha', md5: 'abc123', fileSize: 100 },
  { modId: 2, fileId: 22, name: 'Beta', md5: 'abc123', fileSize: 100 },
  { modId: 3, fileId: 33, name: 'Gamma', md5: 'abc123', fileSize: 100 },
]
const cfg = (mods: SyncMod[], extra: Partial<Parameters<typeof runMassSync>[1]> = {}) => ({
  mods,
  stockGameDir: 'D:/SG',
  steamGamePath: 'C:/Steam/common/Skyrim Special Edition',
  downloadsDir: 'D:/downloads',
  concurrency: 2,
  signal: new AbortController().signal,
  baseMs: 0,
  capMs: 0,
  random: () => 0,
  ...extra,
})

describe('massSync: orchestration', () => {
  it('runs resolve→download→md5→extract into StockGame for every mod', async () => {
    const { deps, calls } = mkDeps()
    const res = await runMassSync(deps, cfg(MODS))
    expect(res.phase).toBe('done')
    expect(res.modsDone).toBe(3)
    expect(res.modsFailed).toBe(0)
    expect(calls.download.length).toBe(3)
    expect(calls.md5).toBe(3)
    expect(calls.extract.every((d) => d.replace(/\\/g, '/').startsWith('D:/SG/mods/'))).toBe(true)
  })

  it('fail-closed on md5 mismatch: archive removed, partial extract dir removed, others continue', async () => {
    const { deps, calls } = mkDeps({ md5: vi.fn(async () => 'WRONG') })
    const res = await runMassSync(deps, cfg(MODS))
    expect(res.modsFailed).toBe(3)
    expect(res.modsDone).toBe(0)
    expect(calls.extract.length).toBe(0)
    // each failure removes BOTH the bad archive and the (empty) dest dir
    expect(calls.removed.some((p) => p.includes('downloads'))).toBe(true)
    expect(calls.removed.some((p) => p.includes('SG/mods/'))).toBe(true)
    expect(res.phase).toBe('error')
  })

  it('texture profile: switching to 2K changes the selected fileId AND the estimated weight', async () => {
    const variantMod: SyncMod = {
      modId: 183,
      fileId: 4000,
      name: '(CBBE) 4K',
      md5: 'abc123',
      fileSize: 300,
      variants: [
        { resolution: '4K', fileId: 4000, name: '(CBBE) 4K', md5: 'abc123', fileSize: 300 },
        { resolution: '2K', fileId: 2000, name: '(CBBE) 2K', md5: 'abc123', fileSize: 120 },
      ],
    }
    const plainMod: SyncMod = { modId: 9, fileId: 90, name: 'NoVariants', md5: 'abc123', fileSize: 50 }
    const run = async (profile: '2K' | '4K') => {
      const picked: Array<[number, number]> = []
      const { deps } = mkDeps({
        resolveLink: vi.fn(async (modId: number, fileId: number) => {
          picked.push([modId, fileId])
          return `https://cdn/files/${fileId}.7z`
        }),
      })
      const res = await runMassSync(deps, cfg([variantMod, plainMod], { textureProfile: profile, concurrency: 1 }))
      return { res, picked }
    }

    // URLs selected coherently: the variant mod resolves to the 4K vs 2K fileId.
    const at4k = await run('4K')
    expect(at4k.picked.find(([m]) => m === 183)?.[1]).toBe(4000)
    expect(at4k.res.bytesTotal).toBe(350) // 300 (4K) + 50

    const at2k = await run('2K')
    expect(at2k.picked.find(([m]) => m === 183)?.[1]).toBe(2000) // switched to the 2K file
    expect(at2k.res.bytesTotal).toBe(170) // 120 (2K) + 50 — lighter

    // The disk-space pre-flight estimate follows the profile (pendingBytes over resolved mods).
    const pending4k = pendingBytes(resolveMods([variantMod, plainMod], '4K'), 'D:/SG/mods', () => false)
    const pending2k = pendingBytes(resolveMods([variantMod, plainMod], '2K'), 'D:/SG/mods', () => false)
    expect(pending2k).toBeLessThan(pending4k)
    expect([pending4k, pending2k]).toEqual([350, 170])
  })

  it('two-phase: installs base then overlays the ITA translation in the SAME dir', async () => {
    const { deps, calls } = mkDeps()
    const translationOf = (modId: number) =>
      modId === 1 ? { nexus_id: 9001, file_id: 500, md5: 'abc123' } : null
    const res = await runMassSync(deps, cfg(MODS, { enableAutoTranslate: true, translationOf }))
    expect(res.phase).toBe('done')
    expect(res.modsDone).toBe(3)
    // Base extract for all 3 mods; overlay ONLY for mod 1 (the one with a translation), same dir.
    expect(calls.extract.map((d) => d.replace(/\\/g, '/'))).toContain('D:/SG/mods/1-Alpha')
    expect(calls.overlay).toEqual(['D:/SG/mods/1-Alpha'])
    // resolveLink called for base (1,2,3) AND the translation (9001).
    expect((deps.resolveLink as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => c[0] === 9001)).toBe(true)
  })

  it('fail-soft: a failing translation leaves the base installed, mod still done, no abort', async () => {
    const { deps, calls } = mkDeps({
      // extractOverlay (Phase B) throws — base already extracted in Phase A.
      extractOverlay: vi.fn(async () => {
        throw new Error('server traduzione giù')
      }),
    })
    const logs: string[] = []
    const translationOf = (modId: number) =>
      modId === 1 ? { nexus_id: 9001, file_id: 500, md5: null } : null
    const res = await runMassSync(deps, cfg(MODS, { enableAutoTranslate: true, translationOf, onLog: (m) => logs.push(m) }))
    expect(res.phase).toBe('done')
    expect(res.modsDone).toBe(3) // ALL mods done despite the translation failure
    expect(res.modsFailed).toBe(0)
    expect(calls.extract.length).toBe(3) // every base extracted
    expect(logs.some((l) => /fail-soft/.test(l))).toBe(true) // logged, not thrown
  })

  it('respects enableAutoTranslate=false: no translation phase', async () => {
    const { deps, calls } = mkDeps()
    const translationOf = (modId: number) => (modId === 1 ? { nexus_id: 9001, file_id: 500, md5: null } : null)
    await runMassSync(deps, cfg(MODS, { enableAutoTranslate: false, translationOf }))
    expect(calls.overlay).toEqual([]) // Phase B never ran
  })

  it('idempotent: skips mods whose dest dir already exists', async () => {
    const { deps, calls } = mkDeps()
    calls.existing.add('D:/SG/mods/2-Beta')
    const res = await runMassSync(deps, cfg(MODS))
    expect(res.modsSkipped).toBe(1)
    expect(res.modsDone).toBe(2)
    expect(calls.download.length).toBe(2)
  })

  it('respects concurrency', async () => {
    const rec = { active: 0, maxActive: 0 }
    const { deps } = mkDeps({}, rec)
    await runMassSync(
      deps,
      cfg([...MODS, ...MODS.map((m) => ({ ...m, modId: m.modId + 9 }))], { concurrency: 2 }),
    )
    expect(rec.maxActive).toBeLessThanOrEqual(2)
    expect(rec.maxActive).toBeGreaterThan(1)
  })

  it('aborts immediately if isolation is violated', async () => {
    const { deps, calls } = mkDeps()
    const steam = 'C:/Steam/common/Skyrim Special Edition'
    await expect(runMassSync(deps, cfg(MODS, { stockGameDir: steam, steamGamePath: steam }))).rejects.toThrow(
      /Isolamento violato/,
    )
    expect(calls.download.length).toBe(0)
  })
})

describe('massSync: hardening', () => {
  it('RETRY: a transient ECONNRESET is retried then succeeds (shared policy)', async () => {
    let attempts = 0
    const { deps } = mkDeps({
      streamDownload: vi.fn(async (_u, _d, onP) => {
        attempts++
        if (attempts < 3) throw { code: 'ECONNRESET' }
        onP(100, 100)
        return { bytes: 100 }
      }),
    })
    const res = await runMassSync(deps, cfg([MODS[0]], { concurrency: 1, maxRetries: 5 }))
    expect(res.modsDone).toBe(1)
    expect(attempts).toBe(3)
  })

  it('RETRY: a non-retryable 403 is NOT retried', async () => {
    let attempts = 0
    const { deps } = mkDeps({
      streamDownload: vi.fn(async () => {
        attempts++
        throw { status: 403 }
      }),
    })
    const res = await runMassSync(deps, cfg([MODS[0]], { concurrency: 1, maxRetries: 5 }))
    expect(res.modsFailed).toBe(1)
    expect(attempts).toBe(1)
  })

  it('CIRCUIT BREAKER: halts the run after the threshold of consecutive failures', async () => {
    const { deps } = mkDeps({
      streamDownload: vi.fn(async () => {
        throw { code: 'ETIMEDOUT' }
      }),
    })
    const big = Array.from({ length: 10 }, (_, i) => ({
      modId: i + 1,
      fileId: i + 1,
      name: `M${i}`,
      md5: 'abc123',
      fileSize: 100,
    }))
    const res = await runMassSync(deps, cfg(big, { concurrency: 1, maxRetries: 0, errorThreshold: 3 }))
    expect(res.phase).toBe('error')
    expect(res.modsFailed).toBe(3) // breaker opens at 3, run halts → not all 10 attempted
  })

  it('TELEMETRY: bytesDownloaded is byte-precise and throughput/ETA are exposed', async () => {
    let clock = 0
    const { deps } = mkDeps({
      streamDownload: vi.fn(async (_u, _d, onP) => {
        onP(40, 100)
        onP(100, 100)
        return { bytes: 100 }
      }),
    })
    const seen: SyncProgress[] = []
    const res = await runMassSync(
      deps,
      cfg([MODS[0], MODS[1]], {
        concurrency: 1,
        now: () => (clock += 500),
        onProgress: (s) => seen.push(structuredClone(s)),
      }),
    )
    expect(res.bytesDownloaded).toBe(200) // 2 mods × 100 real bytes
    expect(res.bytesTotal).toBe(200)
    // a mid-flight sample shows partial bytes (byte-precise, not a fileSize jump)
    expect(seen.some((s) => s.bytesDownloaded > 0 && s.bytesDownloaded < 200)).toBe(true)
    expect(seen.some((s) => s.throughputMBps > 0)).toBe(true)
    expect(seen.some((s) => s.etaSeconds !== null)).toBe(true)
  })

  it('PHASES: each active item reports downloading→verifying→extracting (no 100→0→100 ambiguity)', async () => {
    const phases = new Set<string>()
    const { deps } = mkDeps({
      streamDownload: vi.fn(async (_u, _d, onP) => {
        onP(100, 100)
        return { bytes: 100 }
      }),
    })
    await runMassSync(
      deps,
      cfg([MODS[0]], { concurrency: 1, onProgress: (s) => s.active.forEach((a) => phases.add(a.phase)) }),
    )
    expect(phases.has('downloading')).toBe(true)
    expect(phases.has('verifying')).toBe(true)
    expect(phases.has('extracting')).toBe(true)
  })

  it('CLEANUP: a failed extract removes the partial dest dir (so resume never sees it as done)', async () => {
    const { deps, calls } = mkDeps({
      extract: vi.fn(async () => {
        throw new Error('7z corrotto')
      }),
    })
    const res = await runMassSync(deps, cfg([MODS[0]], { concurrency: 1, maxRetries: 0 }))
    expect(res.modsFailed).toBe(1)
    expect(calls.removed.some((p) => p.includes('SG/mods/1-Alpha'))).toBe(true)
  })

  it('ABORT: cancellation stops the run and reports cancelled (no leaked active slots)', async () => {
    const ac = new AbortController()
    const { deps } = mkDeps({
      streamDownload: vi.fn(async (_u, _d, onP, signal) => {
        ac.abort()
        if (signal.aborted) throw new Error('annullato')
        onP(100, 100)
        return { bytes: 100 }
      }),
    })
    const res = await runMassSync(deps, cfg(MODS, { concurrency: 1, signal: ac.signal }))
    expect(res.phase).toBe('cancelled')
    expect(res.active.length).toBe(0) // no leaked in-flight slots
  })
})

describe('massSync: PRECHECK-01 disk pre-flight', () => {
  it('defaults to overhead 1.5 / safety 1.15 and counts the archive cache', () => {
    const GB = 1024 ** 3
    const pf = computeDiskPreflight({ pendingBytes: 100 * GB, freeBytes: 400 * GB })
    expect(pf.extractionOverhead).toBe(1.5) // honest: was 1.10, too optimistic for texture archives
    expect(pf.safetyFactor).toBe(1.15)
    // cross-disk: cache(pending) + extracted×safety = 100 + 100×1.5×1.15 = 272.5 GB
    expect(pf.requiredBytes).toBe(Math.ceil(100 * GB + 100 * GB * 1.5 * 1.15))
    expect(pf.ok).toBe(true) // 400 free − 272.5 req = 127.5 GB residual > 15 GB floor
    expect(pf.marginBytes).toBeGreaterThan(0)
  })
  it('includes the retained archive cache on BOTH cross- and same-disk paths', () => {
    const cross = computeDiskPreflight({ pendingBytes: 100, freeBytes: 1e9, extractionOverhead: 2, safetyFactor: 1 })
    expect(cross.requiredBytes).toBe(300) // cache 100 + extracted 200 ×1 — cache NOT dropped
    const same = computeDiskPreflight({ pendingBytes: 100, freeBytes: 1e9, extractionOverhead: 2, sameDisk: true })
    expect(same.requiredBytes).toBe(100 + 200 * 1.5) // cache 100 + extracted 200 × 1.5 headroom = 400
  })
  it('flags NO-GO when free < required (optimism no longer hides a shortfall)', () => {
    const GB = 1024 ** 3
    // 110 GB free would PASS the old 1.10×1.15≈126 estimate margin, but the honest
    // 272.5 GB requirement correctly blocks it before any download starts.
    const tight = computeDiskPreflight({ pendingBytes: 100 * GB, freeBytes: 110 * GB })
    expect(tight.ok).toBe(false)
    expect(tight.marginBytes).toBeLessThan(0)
  })
  it('pendingBytes sums only mods whose dest dir does NOT already exist', () => {
    const exists = (p: string) => p.replace(/\\/g, '/') === 'D:/SG/mods/2-Beta'
    expect(pendingBytes(MODS, 'D:/SG/mods', exists)).toBe(200) // Alpha+Gamma (100+100); Beta skipped
  })

  it('runMassSync BLOCKS before any download when space is insufficient (fail-closed)', async () => {
    // pending = 300 B, required = 300 + 300×1.5×headroom B ≥ 818 B, free = 100 B → NO-GO
    const { deps, calls } = mkDeps({ freeSpace: vi.fn(async () => 100) })
    await expect(runMassSync(deps, cfg(MODS, { concurrency: 2 }))).rejects.toThrow(
      /Spazio su disco insufficiente/,
    )
    expect(calls.download.length).toBe(0) // nothing downloaded
    expect(deps.resolveLink).not.toHaveBeenCalled()
  })
  it('skipDiskCheck bypasses the pre-flight', async () => {
    const { deps, calls } = mkDeps({ freeSpace: vi.fn(async () => 1) })
    const res = await runMassSync(deps, cfg(MODS, { concurrency: 2, skipDiskCheck: true }))
    expect(res.modsDone).toBe(3)
    expect(calls.download.length).toBe(3)
  })
})
