import { describe, it, expect } from 'vitest'
import {
  assessDiskSpace,
  estimateInstallFootprint,
  getFreeSpace,
  formatBytes,
  EXTRACTION_FACTOR,
  DEFAULT_MARGIN_BYTES,
} from './diskSpace'

const GB = 1024 ** 3

describe('disk-space assessment', () => {
  it('passes when free space covers required + margin', () => {
    const r = assessDiskSpace({ requiredBytes: 2 * GB, freeBytes: 10 * GB })
    expect(r.ok).toBe(true)
    expect(r.shortfallBytes).toBe(0)
    expect(r.requiredBytes).toBe(2 * GB + DEFAULT_MARGIN_BYTES)
  })

  it('fails and reports the shortfall when space is insufficient', () => {
    const r = assessDiskSpace({ requiredBytes: 10 * GB, freeBytes: 5 * GB, marginBytes: 0 })
    expect(r.ok).toBe(false)
    expect(r.shortfallBytes).toBe(5 * GB)
  })

  it('applies the safety margin (just-too-small free space is rejected)', () => {
    const r = assessDiskSpace({ requiredBytes: 1 * GB, freeBytes: 1 * GB + 100 }) // < required + default margin
    expect(r.ok).toBe(false)
  })

  it('clamps a negative required size to zero (margin only)', () => {
    const r = assessDiskSpace({ requiredBytes: -5, freeBytes: GB, marginBytes: 0 })
    expect(r.requiredBytes).toBe(0)
    expect(r.ok).toBe(true)
  })
})

describe('install footprint estimate', () => {
  it('scales the archive size by the extraction factor (ceil)', () => {
    expect(estimateInstallFootprint(1000)).toBe(Math.ceil(1000 * EXTRACTION_FACTOR))
    expect(estimateInstallFootprint(0)).toBe(0)
    expect(estimateInstallFootprint(-10)).toBe(0)
  })
})

describe('getFreeSpace (best-effort, fail-open)', () => {
  it('returns a finite positive number for a real directory', async () => {
    const free = await getFreeSpace(process.cwd())
    expect(Number.isFinite(free)).toBe(true)
    expect(free).toBeGreaterThan(0)
  })

  it('never returns NaN/0 for a not-yet-existing nested path (walks up to the volume)', async () => {
    const free = await getFreeSpace(process.cwd() + '/__does_not_exist__/deep/child')
    expect(free).toBeGreaterThan(0) // resolves the parent volume, or Infinity if unreadable
  })
})

describe('formatBytes', () => {
  it('formats common magnitudes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * GB)).toBe('5 GB')
    expect(formatBytes(Infinity)).toBe('∞')
  })
})
