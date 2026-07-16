import { describe, it, expect, vi } from 'vitest'
import { runAutoRepair, deployNeeded, type AutoRepairDeps, type DeployDrift } from './autoRepair'

const INTACT: DeployDrift = { checked: true, missingCount: 0, replacedCount: 0, junctionsMissingCount: 0 }
const NEVER_DEPLOYED: DeployDrift = { checked: false, missingCount: 0, replacedCount: 0, junctionsMissingCount: 0 }
const DRIFTED: DeployDrift = { checked: true, missingCount: 3, replacedCount: 1, junctionsMissingCount: 0 }

function deps(over: Partial<AutoRepairDeps> = {}): AutoRepairDeps {
  return {
    enabled: () => true,
    registerInstalled: () => ({ inserted: 0, updated: 0 }),
    verifyDeploy: () => INTACT,
    deploy: async () => ({ success: true, modsLinked: 49, pluginsWritten: 10 }),
    backup: async () => ({ success: true }),
    ...over,
  }
}

describe('deployNeeded', () => {
  it('mai distribuito → serve', () => {
    expect(deployNeeded(NEVER_DEPLOYED)).toEqual({ needed: true, reason: 'mod mai collegate al gioco' })
  })
  it('deriva rilevata → serve, con il motivo leggibile', () => {
    const r = deployNeeded(DRIFTED)
    expect(r.needed).toBe(true)
    expect(r.reason).toContain('3 file mancanti')
    expect(r.reason).toContain('1 sostituiti esternamente')
  })
  it('deploy integro → non serve', () => {
    expect(deployNeeded(INTACT)).toEqual({ needed: false, reason: 'deploy integro' })
  })
  it('stato non determinabile → NON deploya (mai azioni al buio)', () => {
    expect(deployNeeded(null).needed).toBe(false)
  })
})

describe('runAutoRepair', () => {
  it('disattivata → non tocca nulla', async () => {
    const deploy = vi.fn()
    const r = await runAutoRepair(deps({ enabled: () => false, deploy }))
    expect(r.enabled).toBe(false)
    expect(r.changed).toBe(false)
    expect(deploy).not.toHaveBeenCalled()
  })

  it('sistema già a posto → nessuna azione, idempotente', async () => {
    const deploy = vi.fn()
    const r = await runAutoRepair(deps({ deploy }))
    expect(r.changed).toBe(false)
    expect(r.failed).toBe(false)
    expect(r.summary).toBe('Nessuna riparazione necessaria')
    expect(deploy).not.toHaveBeenCalled() // deploy integro: non si ridistribuisce a vuoto
  })

  it('mai distribuito → deploya (= ordina e attiva i plugin) senza intervento utente', async () => {
    const deploy = vi.fn(async () => ({ success: true, modsLinked: 49, pluginsWritten: 10 }))
    const r = await runAutoRepair(deps({ verifyDeploy: () => NEVER_DEPLOYED, deploy }))
    expect(deploy).toHaveBeenCalledOnce()
    expect(r.changed).toBe(true)
    expect(r.failed).toBe(false)
    expect(r.summary).toMatch(/10 plugin ordinati e attivati/)
  })

  it('deriva esterna → ridistribuisce da sé', async () => {
    const deploy = vi.fn(async () => ({ success: true, modsLinked: 49, pluginsWritten: 10 }))
    const r = await runAutoRepair(deps({ verifyDeploy: () => DRIFTED, deploy }))
    expect(deploy).toHaveBeenCalledOnce()
    expect(r.changed).toBe(true)
  })

  it('backup PRIMA del deploy automatico (riparazione sempre annullabile)', async () => {
    const order: string[] = []
    await runAutoRepair(
      deps({
        verifyDeploy: () => NEVER_DEPLOYED,
        backup: async () => {
          order.push('backup')
          return { success: true }
        },
        deploy: async () => {
          order.push('deploy')
          return { success: true }
        },
      }),
    )
    expect(order).toEqual(['backup', 'deploy'])
  })

  it('nessun backup configurato → deploya comunque (backup opzionale)', async () => {
    const deploy = vi.fn(async () => ({ success: true }))
    const r = await runAutoRepair(deps({ verifyDeploy: () => NEVER_DEPLOYED, backup: undefined, deploy }))
    expect(deploy).toHaveBeenCalledOnce()
    expect(r.actions.some((a) => a.id === 'backup')).toBe(false)
  })

  it('registra le estrazioni non note (senza, il deploy non le vedrebbe)', async () => {
    const r = await runAutoRepair(deps({ registerInstalled: () => ({ inserted: 54, updated: 0 }) }))
    expect(r.changed).toBe(true)
    expect(r.summary).toMatch(/54 mod registrate/)
  })

  it('registrazione PRIMA della verifica del deploy (ordine causale)', async () => {
    const order: string[] = []
    await runAutoRepair(
      deps({
        registerInstalled: () => {
          order.push('register')
          return { inserted: 1, updated: 0 }
        },
        verifyDeploy: () => {
          order.push('verify')
          return INTACT
        },
      }),
    )
    expect(order).toEqual(['register', 'verify'])
  })

  it('deploy fallito → failed, MAI throw: le verifiche a valle decidono', async () => {
    const r = await runAutoRepair(
      deps({
        verifyDeploy: () => NEVER_DEPLOYED,
        deploy: async () => ({ success: false, error: 'cross-volume' }),
      }),
    )
    expect(r.failed).toBe(true)
    expect(r.summary).toMatch(/cross-volume/)
  })

  it('dep che LANCIA → catturato come azione fallita, mai propagato', async () => {
    const r = await runAutoRepair(
      deps({
        verifyDeploy: () => NEVER_DEPLOYED,
        deploy: async () => {
          throw new Error('handle bloccato')
        },
      }),
    )
    expect(r.failed).toBe(true)
    expect(r.actions.find((a) => a.id === 'deploy')?.error).toBe('handle bloccato')
  })

  it('verifica del deploy che lancia → nessuna azione al buio', async () => {
    const deploy = vi.fn()
    const r = await runAutoRepair(
      deps({
        verifyDeploy: () => {
          throw new Error('disco non leggibile')
        },
        deploy,
      }),
    )
    expect(deploy).not.toHaveBeenCalled()
    expect(r.changed).toBe(false)
  })

  it('backup fallito NON impedisce il deploy (il gioco resta avviabile)', async () => {
    const deploy = vi.fn(async () => ({ success: true }))
    const r = await runAutoRepair(
      deps({
        verifyDeploy: () => NEVER_DEPLOYED,
        backup: async () => ({ success: false, error: 'disco pieno' }),
        deploy,
      }),
    )
    expect(deploy).toHaveBeenCalledOnce()
    expect(r.failed).toBe(true) // segnalato...
    expect(r.actions.find((a) => a.id === 'deploy')?.changed).toBe(true) // ...ma il deploy è avvenuto
  })
})
