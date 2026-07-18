import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  markerFilePath,
  markerFileExists,
  writeMarkerFile,
  removeMarkerFileIfExists,
  listGrassCacheFiles,
  supervisePrecache,
} from './grassCacheEngine'

describe('marker file IO', () => {
  it('write/exists/remove roundtrip su disco reale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grass-marker-'))
    try {
      expect(markerFileExists(dir)).toBe(false)
      writeMarkerFile(dir)
      expect(markerFileExists(dir)).toBe(true)
      expect(markerFilePath(dir)).toBe(join(dir, 'PrecacheGrass.txt'))
      removeMarkerFileIfExists(dir)
      expect(markerFileExists(dir)).toBe(false)
      // Rimuovere un marker già assente non deve throw.
      expect(() => removeMarkerFileIfExists(dir)).not.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('listGrassCacheFiles', () => {
  it('cartella Data/Grass assente → []', () => {
    expect(listGrassCacheFiles('C:/percorso/inesistente/xyz')).toEqual([])
  })
})

const sleepNoop = () => Promise.resolve()

describe('supervisePrecache', () => {
  it('marker già assente all-inizio → completed senza lanciare nulla', async () => {
    const launch = vi.fn()
    const r = await supervisePrecache({ launch, isGameRunning: () => false, markerExists: () => false, sleep: sleepNoop })
    expect(r.completed).toBe(true)
    expect(r.attempts).toBe(0)
    expect(launch).not.toHaveBeenCalled()
  })

  it('un solo lancio, il gioco gira poi termina, marker rimosso → completed', async () => {
    let marker = true
    const isGameRunning = vi.fn(() => {
      // Il gioco "termina" alla prima poll: simuliamo che NGIO abbia già rimosso il marker.
      marker = false
      return false
    })
    const r = await supervisePrecache({
      launch: () => ({ success: true, pid: 123 }),
      isGameRunning,
      markerExists: () => marker,
      sleep: sleepNoop,
      startupGraceMs: -1, // nel test il tempo trascorso è ~0ms: disabilitiamo la grace per isolare la logica di rilancio
    })
    expect(r.completed).toBe(true)
    expect(r.attempts).toBe(1)
  })

  it('lancio fallito → si ferma subito, non riprova', async () => {
    const launch = vi.fn(() => ({ success: false, error: 'ENOENT' }))
    const r = await supervisePrecache({ launch, isGameRunning: () => false, markerExists: () => true, sleep: sleepNoop })
    expect(r.completed).toBe(false)
    expect(r.attempts).toBe(1)
    expect(r.reason).toMatch(/ENOENT/)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('raggiunge maxAttempts senza completare → fallisce con motivo esplicito', async () => {
    const r = await supervisePrecache({
      launch: () => ({ success: true }),
      isGameRunning: () => false,
      markerExists: () => true, // non si rimuove mai
      sleep: sleepNoop,
      maxAttempts: 3,
      startupGraceMs: -1,
    })
    expect(r.completed).toBe(false)
    expect(r.attempts).toBe(3)
    expect(r.reason).toMatch(/3 rilanci/)
  })

  it('uscita quasi immediata (crash all-avvio) → si ferma senza consumare tutti i tentativi', async () => {
    const launch = vi.fn(() => ({ success: true }))
    const r = await supervisePrecache({
      launch,
      isGameRunning: () => false, // "termina" subito
      markerExists: () => true,
      sleep: sleepNoop,
      startupGraceMs: 999999, // qualunque durata reale nel test è sotto questa soglia
      maxAttempts: 10,
    })
    expect(r.completed).toBe(false)
    expect(r.attempts).toBe(1)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(r.reason).toMatch(/crash all'avvio/)
  })

  it('onProgress riceve un evento per tentativo', async () => {
    const events: string[] = []
    await supervisePrecache({
      launch: () => ({ success: true }),
      isGameRunning: () => false,
      markerExists: () => false,
      sleep: sleepNoop,
      onProgress: (ev) => events.push(ev.status),
    })
    // marker già assente: nessun lancio, nessun evento.
    expect(events).toEqual([])
  })
})
