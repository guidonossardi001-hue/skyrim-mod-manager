import { describe, it, expect } from 'vitest'
import { suggestedMaxTier, tierExceedsHardware, detectHardwareInfo, TIER_ORDER } from './hardwareInfo'

describe('suggestedMaxTier', () => {
  it('nessun dato (VRAM e RAM entrambi ignoti) → null, mai un consiglio inventato', () => {
    expect(suggestedMaxTier({ gpuVramGB: null, ramGB: null })).toBeNull()
  })

  it('hardware modesto (2GB VRAM, 8GB RAM) → low', () => {
    expect(suggestedMaxTier({ gpuVramGB: 2, ramGB: 8 })).toBe('low')
  })

  it('hardware potente (12GB VRAM, 32GB RAM) → ultra', () => {
    expect(suggestedMaxTier({ gpuVramGB: 12, ramGB: 32 })).toBe('ultra')
  })

  it('hardware sotto ogni soglia (1GB VRAM, 4GB RAM) → poor (mai negativo/assente)', () => {
    expect(suggestedMaxTier({ gpuVramGB: 1, ramGB: 4 })).toBe('poor')
  })

  it('il collo di bottiglia è il minimo dei due assi (VRAM alta ma RAM bassa)', () => {
    // 8GB VRAM da soli darebbero 'ultra', ma 8GB RAM tengono a 'medium' (high richiede 16GB RAM)
    expect(suggestedMaxTier({ gpuVramGB: 8, ramGB: 8 })).toBe('medium')
  })

  it('solo un dato disponibile (GPU non rilevata, RAM sì) → consiglio sul solo asse noto', () => {
    expect(suggestedMaxTier({ gpuVramGB: null, ramGB: 32 })).toBe('ultra')
    expect(suggestedMaxTier({ gpuVramGB: 8, ramGB: null })).toBe('ultra')
  })
})

describe('tierExceedsHardware', () => {
  it('tier scelto sopra il consigliato → true', () => {
    expect(tierExceedsHardware('ultra', { gpuVramGB: 2, ramGB: 8 })).toBe(true)
  })

  it('tier scelto entro il consigliato → false', () => {
    expect(tierExceedsHardware('low', { gpuVramGB: 2, ramGB: 8 })).toBe(false)
    expect(tierExceedsHardware('poor', { gpuVramGB: 2, ramGB: 8 })).toBe(false)
  })

  it('tier scelto esattamente al livello consigliato → false (non è un eccesso)', () => {
    expect(tierExceedsHardware('medium', { gpuVramGB: 8, ramGB: 8 })).toBe(false)
  })

  it('nessun dato hardware → sempre false, mai un avviso spurio', () => {
    expect(tierExceedsHardware('ultra', { gpuVramGB: null, ramGB: null })).toBe(false)
  })

  it('TIER_ORDER copre esattamente i 5 tier, dal più basso al più alto', () => {
    expect(TIER_ORDER).toEqual(['poor', 'low', 'medium', 'high', 'ultra'])
  })
})

describe('detectHardwareInfo', () => {
  it('os.* sempre popolati; GPU dal probe iniettato quando il JSON è valido', () => {
    const fakeExec = () => JSON.stringify({ Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 8 * 1024 ** 3 })
    const hw = detectHardwareInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(hw.cpuCores).toBeGreaterThan(0)
    expect(hw.ramGB).toBeGreaterThan(0)
    expect(hw.gpuName).toBe('NVIDIA GeForce RTX 4090')
    expect(hw.gpuVramGB).toBe(8)
  })

  it('AdapterRAM negativo/zero (overflow WMI noto per GPU >4GB) → gpuVramGB null, mai un numero sbagliato', () => {
    const fakeExec = () => JSON.stringify({ Name: 'GPU moderna', AdapterRAM: -2147483648 })
    const hw = detectHardwareInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(hw.gpuVramGB).toBeNull()
    expect(hw.gpuName).toBe('GPU moderna') // il nome resta valido anche se la VRAM non è attendibile
  })

  it('probe PowerShell che lancia (assente/timeout) → GPU null, mai un throw propagato', () => {
    const fakeExec = () => {
      throw new Error('powershell not found')
    }
    expect(() =>
      detectHardwareInfo(fakeExec as unknown as typeof import('child_process').execFileSync),
    ).not.toThrow()
    const hw = detectHardwareInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(hw.gpuName).toBeNull()
    expect(hw.gpuVramGB).toBeNull()
    expect(hw.cpuCores).toBeGreaterThan(0) // i dati os.* restano comunque popolati
  })

  it('JSON malformato → GPU null, mai un throw propagato', () => {
    const fakeExec = () => 'not-json{{{'
    const hw = detectHardwareInfo(fakeExec as unknown as typeof import('child_process').execFileSync)
    expect(hw.gpuName).toBeNull()
    expect(hw.gpuVramGB).toBeNull()
  })
})
