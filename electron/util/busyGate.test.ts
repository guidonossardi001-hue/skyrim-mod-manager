import { describe, it, expect, afterEach } from 'vitest'
import { tryAcquireBusyGate, releaseBusyGate, currentBusyLabel } from './busyGate'

afterEach(() => releaseBusyGate()) // isola i test: mai un lock dimenticato tra uno e l'altro

describe('busyGate', () => {
  it('primo acquire riesce, un secondo mentre è occupato fallisce', () => {
    expect(tryAcquireBusyGate('deploy')).toBe(true)
    expect(tryAcquireBusyGate('fomod')).toBe(false)
    expect(currentBusyLabel()).toBe('deploy') // il primo occupante resta quello riportato
  })

  it('release libera il gate per il prossimo acquire', () => {
    expect(tryAcquireBusyGate('deploy')).toBe(true)
    releaseBusyGate()
    expect(currentBusyLabel()).toBeNull()
    expect(tryAcquireBusyGate('bodyslide')).toBe(true)
  })

  it('release su gate già libero è no-op sicuro', () => {
    releaseBusyGate()
    releaseBusyGate()
    expect(currentBusyLabel()).toBeNull()
  })
})
