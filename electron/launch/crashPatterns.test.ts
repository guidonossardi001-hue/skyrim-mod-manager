import { describe, it, expect } from 'vitest'
import { matchCrashPatterns, CRASH_PATTERN_CATEGORIES } from './crashPatterns'

describe('matchCrashPatterns', () => {
  it('driver NVIDIA riconosciuto con firma nel call stack', () => {
    const m = matchCrashPatterns('...\n[2] 0x7FF nvwgf2umx.dll+0x1234\n...')
    expect(m.map((x) => x.id)).toContain('nvidia-driver')
    expect(m.find((x) => x.id === 'nvidia-driver')!.matched).toEqual(['nvwgf2umx.dll'])
  })

  it('behaviour Havok → consiglio Pandora del launcher', () => {
    const m = matchCrashPatterns('POSSIBLE RELEVANT OBJECTS:\n  (hkbStateMachine*)\n  (hkbClipGenerator*)')
    const b = m.find((x) => x.id === 'behaviour')!
    expect(b.matched).toEqual(['hkbclipgenerator', 'hkbstatemachine'])
    expect(b.advice).toMatch(/Pandora/)
  })

  it('KERNELBASE da solo → mostrato ma come unico (sintomo), senza rumore', () => {
    const m = matchCrashPatterns('Unhandled exception at KERNELBASE.dll+0x1000')
    expect(m).toHaveLength(1)
    expect(m[0].id).toBe('kernelbase')
    expect(m[0].advice).toMatch(/SINTOMO/i)
  })

  it('KERNELBASE accanto a categoria forte → ordinato per priorità (forte prima)', () => {
    const m = matchCrashPatterns('KERNELBASE.dll ... memory allocation failed ...')
    expect(m[0].id).toBe('memoria')
    expect(m.map((x) => x.id)).toContain('kernelbase')
  })

  it('case-insensitive; nessun match → lista vuota', () => {
    expect(matchCrashPatterns('NVWGF2UMX.DLL').map((x) => x.id)).toContain('nvidia-driver')
    expect(matchCrashPatterns('log pulito senza firme note')).toEqual([])
  })

  it('categorie ben formate: id/label/advice non vuoti, firme lowercase-matchabili', () => {
    for (const c of CRASH_PATTERN_CATEGORIES) {
      expect(c.id).toBeTruthy()
      expect(c.label).toBeTruthy()
      expect(c.advice.length).toBeGreaterThan(30)
      expect(c.signatures.length).toBeGreaterThan(0)
    }
  })
})
