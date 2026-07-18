import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hasFomod, applyFomodInstructions, type FomodInstruction } from './fomodApply'

const roots: string[] = []
function tmpMod(structure: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'smm-fomod-'))
  roots.push(root)
  for (const rel of structure) {
    const abs = join(root, rel)
    if (rel.endsWith('/')) mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, 'x')
    }
  }
  return root
}
afterAll(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

const copyInstruction = (source: string, destination: string): FomodInstruction => ({
  type: 'copy',
  source,
  destination,
})

describe('applyFomodInstructions', () => {
  it('happy path: swap riuscito, marker presente, avanzi contati', () => {
    const mod = tmpMod(['Data/plugin.esp', 'fomod/ModuleConfig.xml'])
    const r = applyFomodInstructions(mod, [copyInstruction('Data/plugin.esp', 'plugin.esp')], { preset: [] })
    expect(r.ok).toBe(true)
    expect(r.filesMapped).toBe(1)
    expect(existsSync(join(mod, 'plugin.esp'))).toBe(true)
    expect(existsSync(join(mod, '.smm-fomod-applied.json'))).toBe(true)
  })

  it('nessuna instruction copy valida → errore, cartella intatta', () => {
    const mod = tmpMod(['Data/plugin.esp'])
    const r = applyFomodInstructions(mod, [{ type: 'noop', source: '', destination: '' }], { preset: [] })
    expect(r.ok).toBe(false)
    expect(existsSync(join(mod, 'Data', 'plugin.esp'))).toBe(true)
  })
})

// ── Fallimento del SECONDO rename dello swap (mapped → modDir): bug reale in cui il
// rollback file-per-file falliva silenziosamente su path ormai inesistenti e poi
// CANCELLAVA `mapped` — l'unica copia buona rimasta — distruggendo la mod. Il secondo
// rename va mockato per fallire deterministicamente (impossibile riprodurlo con la sola
// filesystem reale in un test rapido e portabile). `vi.hoisted` conserva un riferimento
// alla renameSync VERA, così lo spy può delegarle le rename che non vogliamo simulare fallite.
const hoisted = vi.hoisted(() => ({
  renameSyncSpy: vi.fn(),
  actualRenameSync: null as unknown as (from: string, to: string) => void,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  hoisted.actualRenameSync = actual.renameSync
  hoisted.renameSyncSpy.mockImplementation((from: string, to: string) => actual.renameSync(from, to))
  return { ...actual, renameSync: (from: string, to: string) => hoisted.renameSyncSpy(from, to) }
})

describe('applyFomodInstructions — fallimento swap (secondo rename)', () => {
  beforeEach(() => {
    hoisted.renameSyncSpy.mockClear()
  })

  it('secondo rename fallito → NESSUNA perdita: mapped intatta, modDir ripristinato dal discard', () => {
    const mod = tmpMod(['Data/plugin.esp', 'Data/readme.txt'])
    hoisted.renameSyncSpy.mockImplementation((from: string, to: string) => {
      // Solo la SECONDA rename dello swap (mapped -> modDir) fallisce; tutto il resto
      // (compreso il setup di tmpMod, che gira PRIMA di questa mockImplementation) passa reale.
      if (to === mod && from.endsWith('.smm-mapped')) throw new Error('EPERM: simulated lock on second rename')
      return hoisted.actualRenameSync(from, to)
    })

    const r = applyFomodInstructions(mod, [copyInstruction('Data/plugin.esp', 'plugin.esp')], { preset: [] })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ripristinato/)
    // modDir è tornato allo stato pre-swap (= quello di 'discard'): plugin.esp era GIÀ stato
    // spostato in mapped durante il loop di copia (corretto), readme.txt non era tra le
    // instruction quindi resta nel modDir ripristinato.
    expect(existsSync(mod)).toBe(true)
    expect(existsSync(join(mod, 'Data', 'readme.txt'))).toBe(true)
    expect(existsSync(join(mod, 'Data', 'plugin.esp'))).toBe(false)
    // 'mapped' NON è stata cancellata (a differenza del bug: prima veniva rmSync-ata qui) —
    // il file processato correttamente resta salvo e recuperabile.
    expect(existsSync(mod + '.smm-mapped')).toBe(true)
    expect(existsSync(join(mod + '.smm-mapped', 'plugin.esp'))).toBe(true)
  })
})

describe('hasFomod — root e wrapper annidati', () => {
  it('config alla radice → true (comportamento storico)', () => {
    expect(hasFomod(tmpMod(['fomod/ModuleConfig.xml']))).toBe(true)
  })

  it('case-insensitive su cartella e file', () => {
    expect(hasFomod(tmpMod(['FOMOD/moduleconfig.XML']))).toBe(true)
  })

  it('config dentro UN wrapper → true (caso reale: 137/1939 mod della collection)', () => {
    expect(hasFomod(tmpMod(['Reverb Overhaul/fomod/ModuleConfig.xml', 'Reverb Overhaul/00 Main Files/a.esp']))).toBe(
      true,
    )
  })

  it('config dentro DUE wrapper → true', () => {
    expect(hasFomod(tmpMod(['outer/inner/fomod/ModuleConfig.xml']))).toBe(true)
  })

  it('tre livelli di wrapper → fuori dal raggio di ricerca (bounded): false', () => {
    expect(hasFomod(tmpMod(['a/b/c/fomod/ModuleConfig.xml']))).toBe(false)
  })

  it('nessuna config → false; cartella fomod senza ModuleConfig → false', () => {
    expect(hasFomod(tmpMod(['textures/a.dds']))).toBe(false)
    expect(hasFomod(tmpMod(['fomod/info.xml']))).toBe(false)
  })

  it('directory inesistente → false, mai throw', () => {
    expect(hasFomod('Z:/non/esiste')).toBe(false)
  })
})
