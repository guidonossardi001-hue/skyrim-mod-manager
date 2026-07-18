import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from './rateLimiter'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createRateLimiter', () => {
  it('nessun limite (0/null/undefined) → take() risolve subito, qualunque dimensione', async () => {
    for (const limit of [0, null, undefined, -5]) {
      const rl = createRateLimiter(() => limit)
      let resolved = false
      rl.take(10_000_000).then(() => (resolved = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(true)
    }
  })

  it('richiesta entro il budget dopo un refill → risolve senza attese aggiuntive', async () => {
    const rl = createRateLimiter(() => 1000) // 1000 B/s
    await vi.advanceTimersByTimeAsync(1000) // riempie il bucket (nessuna take ancora fatta)
    let resolved = false
    rl.take(500).then(() => (resolved = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('richiesta oltre il budget disponibile → attende proporzionalmente al mancante', async () => {
    const rl = createRateLimiter(() => 1000) // 1000 B/s, bucket parte vuoto (tokens=0)
    let resolved = false
    rl.take(500).then(() => (resolved = true)) // serve mezzo secondo di refill
    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).toBe(false) // troppo presto
    await vi.advanceTimersByTimeAsync(500)
    expect(resolved).toBe(true) // ~600ms totali, sufficienti per 500 byte a 1000 B/s
  })

  it('richiesta molto più grande del budget/secondo → si esaurisce su più cicli, mai un blocco infinito', async () => {
    const rl = createRateLimiter(() => 100) // 100 B/s, chunk da 1000 B → serve ~10s
    let resolved = false
    rl.take(1000).then(() => (resolved = true))
    await vi.advanceTimersByTimeAsync(5000)
    expect(resolved).toBe(false) // a metà strada
    await vi.advanceTimersByTimeAsync(6000)
    expect(resolved).toBe(true) // ormai oltre i ~10s necessari
  })

  it('limite abbassato a runtime (getLimitBps dinamico) mentre una take() è in attesa → si applica al prossimo ricontrollo', async () => {
    let limit = 100
    const rl = createRateLimiter(() => limit)
    let resolved = false
    rl.take(1000).then(() => (resolved = true)) // a 100 B/s servirebbero ~10s
    await vi.advanceTimersByTimeAsync(500)
    expect(resolved).toBe(false)
    limit = 0 // l'utente disattiva il limite mentre il download è in corso
    await vi.advanceTimersByTimeAsync(200) // entro il prossimo ricontrollo (max 200ms)
    expect(resolved).toBe(true)
  })

  it('budget condiviso: due take() concorrenti si dividono lo STESSO bucket (aggregato, non per-download)', async () => {
    const rl = createRateLimiter(() => 1000) // 1000 B/s totali
    await vi.advanceTimersByTimeAsync(1000) // bucket pieno: 1000 token disponibili
    let aDone = false
    let bDone = false
    rl.take(700).then(() => (aDone = true))
    rl.take(700).then(() => (bDone = true))
    await vi.advanceTimersByTimeAsync(0)
    // Solo 1000 token disponibili per 1400 byte richiesti in totale: non possono finire entrambi subito.
    expect(aDone && bDone).toBe(false)
  })
})
