import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { verifyDeployedInstance, hasDeployDrift, type VerifyIo } from './verifyDeploy'
import { DEPLOY_MANIFEST_FILE } from './plan'
import { ACCEPTED_OVERRIDES_FILE } from './driftResolve'

const DATA = 'C:\\game\\Data'

function manifestJson(files: string[], junctions: string[] = [], copied: string[] = []): string {
  return JSON.stringify({ version: 1, target: DATA, files, junctions, copied })
}

interface FakeEntry {
  nlink?: number
  dir?: boolean
  /** Reparse point (junction reale su Windows): lstat dà isDirectory FALSE. */
  reparse?: boolean
}

function fakeIo(
  manifest: string | null,
  disk: Record<string, FakeEntry>,
  acceptedRels?: string[],
): VerifyIo {
  const manifestPath = join(DATA, DEPLOY_MANIFEST_FILE)
  const acceptedPath = join(DATA, ACCEPTED_OVERRIDES_FILE)
  return {
    exists: (p) =>
      p === manifestPath ? manifest !== null : p === acceptedPath ? acceptedRels !== undefined : p in disk,
    readFile: (p) => {
      if (p === manifestPath && manifest !== null) return manifest
      if (p === acceptedPath && acceptedRels !== undefined) return JSON.stringify(acceptedRels)
      throw new Error('ENOENT')
    },
    lstat: (p) => {
      const e = disk[p]
      if (!e) return null
      return {
        nlink: e.nlink ?? 2,
        isFile: !e.dir && !e.reparse,
        isDirectory: !!e.dir && !e.reparse,
        isSymbolicLink: !!e.reparse,
      }
    },
  }
}

describe('verifyDeployedInstance', () => {
  it('manifest assente → checked:false (mai deployato o già purgato)', () => {
    const r = verifyDeployedInstance(DATA, fakeIo(null, {}))
    expect(r.checked).toBe(false)
    expect(hasDeployDrift(r)).toBe(false)
  })

  it('manifest corrotto → checked:false, mai throw', () => {
    const r = verifyDeployedInstance(DATA, fakeIo('{not json', {}))
    expect(r.checked).toBe(false)
  })

  it('deploy intatto: tutti hardlink vivi + junction presenti → zero drift', () => {
    const io = fakeIo(manifestJson(['a.esp', 'meshes\\m.nif'], ['textures\\big']), {
      [join(DATA, 'a.esp')]: { nlink: 2 },
      [join(DATA, 'meshes\\m.nif')]: { nlink: 3 },
      [join(DATA, 'textures\\big')]: { dir: true },
    })
    const r = verifyDeployedInstance(DATA, io)
    expect(r).toMatchObject({
      checked: true,
      totalFiles: 2,
      intactFiles: 2,
      missingCount: 0,
      replacedCount: 0,
      junctionsMissingCount: 0,
    })
    expect(hasDeployDrift(r)).toBe(false)
  })

  it('junction REALE Windows (reparse point: lstat isDirectory=false, isSymbolicLink=true) → intatta', () => {
    // Bug reale 2026-07-17: 5323 junction sane giudicate "scollegate" a ogni avvio
    // (il check guardava solo isDirectory) → rideploy completo inutile della riparazione.
    const io = fakeIo(manifestJson(['a.esp'], ['textures\\big', 'meshes\\set']), {
      [join(DATA, 'a.esp')]: { nlink: 2 },
      [join(DATA, 'textures\\big')]: { reparse: true },
      [join(DATA, 'meshes\\set')]: { reparse: true },
    })
    const r = verifyDeployedInstance(DATA, io)
    expect(r.junctionsMissingCount).toBe(0)
    expect(hasDeployDrift(r)).toBe(false)
  })

  it('TOOL-MANAGED: Config.xml di BodySlide riscritto (nlink 1) NON è drift', () => {
    // Caso reale: la card BodySlide riscrive Config.xml come file reale prima di ogni
    // build → senza whitelist il verify segnava 1 "replaced" per sempre e la riparazione
    // automatica rideployava a OGNI avvio.
    const io = fakeIo(manifestJson(['a.esp', 'CalienteTools\\BodySlide\\Config.xml']), {
      [join(DATA, 'a.esp')]: { nlink: 2 },
      [join(DATA, 'CalienteTools\\BodySlide\\Config.xml')]: { nlink: 1 },
    })
    const r = verifyDeployedInstance(DATA, io)
    expect(r.replacedCount).toBe(0)
    expect(r.intactFiles).toBe(2)
    expect(hasDeployDrift(r)).toBe(false)
  })

  it('file cancellato esternamente → missing', () => {
    const io = fakeIo(manifestJson(['a.esp', 'b.esp']), {
      [join(DATA, 'a.esp')]: { nlink: 2 },
    })
    const r = verifyDeployedInstance(DATA, io)
    expect(r.missingCount).toBe(1)
    expect(r.missing).toEqual(['b.esp'])
    expect(hasDeployDrift(r)).toBe(true)
  })

  it('file sostituito da copia esterna (nlink=1) → replaced', () => {
    const io = fakeIo(manifestJson(['a.esp']), {
      [join(DATA, 'a.esp')]: { nlink: 1 },
    })
    const r = verifyDeployedInstance(DATA, io)
    expect(r.replacedCount).toBe(1)
    expect(r.replaced).toEqual(['a.esp'])
    expect(hasDeployDrift(r)).toBe(true)
  })

  it('file deployato per copia (fallback cross-volume, nlink=1 normale) NON è drift', () => {
    // manifest.copied marca i file EXDEV-fallback: nlink 1 è il loro stato atteso, non un
    // segnale di sostituzione esterna (a differenza di un vero hardlink nostro).
    const io = fakeIo(manifestJson(['a.esp', 'b.esp'], [], ['a.esp']), {
      [join(DATA, 'a.esp')]: { nlink: 1 }, // copiato: nlink 1 atteso
      [join(DATA, 'b.esp')]: { nlink: 2 }, // hardlink normale
    })
    const r = verifyDeployedInstance(DATA, io)
    expect(r.replacedCount).toBe(0)
    expect(r.intactFiles).toBe(2)
    expect(hasDeployDrift(r)).toBe(false)
  })

  it('file copiato ma REALMENTE mancante resta segnalato (copied esenta solo dal check nlink)', () => {
    const io = fakeIo(manifestJson(['a.esp'], [], ['a.esp']), {})
    const r = verifyDeployedInstance(DATA, io)
    expect(r.missingCount).toBe(1)
    expect(r.missing).toEqual(['a.esp'])
  })

  it('junction scollegata → junctionsMissing', () => {
    const io = fakeIo(manifestJson([], ['textures\\big']), {})
    const r = verifyDeployedInstance(DATA, io)
    expect(r.junctionsMissingCount).toBe(1)
    expect(hasDeployDrift(r)).toBe(true)
  })

  it('campioni cappati a 8 ma conteggi PIENI', () => {
    const files = Array.from({ length: 20 }, (_, i) => `f${i}.esp`)
    const r = verifyDeployedInstance(DATA, fakeIo(manifestJson(files), {}))
    expect(r.missingCount).toBe(20)
    expect(r.missing).toHaveLength(8)
  })

  it('file accettato (deploy:resolve-drift accept) NON è più drift', () => {
    const io = fakeIo(
      manifestJson(['a.esp', 'b.esp']),
      { [join(DATA, 'a.esp')]: { nlink: 2 } }, // b.esp mancante sul disco
      ['b.esp'],
    )
    const r = verifyDeployedInstance(DATA, io)
    expect(r.missingCount).toBe(0)
    expect(r.intactFiles).toBe(2)
    expect(hasDeployDrift(r)).toBe(false)
  })

  it('junction accettata NON è più drift, le altre restano segnalate', () => {
    const io = fakeIo(manifestJson([], ['textures\\big', 'meshes\\gone']), {}, ['textures\\big'])
    const r = verifyDeployedInstance(DATA, io)
    expect(r.junctionsMissingCount).toBe(1)
    expect(r.junctionsMissing).toEqual(['meshes\\gone'])
  })

  it('lstat che lancia su un file → contato missing, la verifica prosegue', () => {
    const io = fakeIo(manifestJson(['a.esp', 'b.esp']), {
      [join(DATA, 'a.esp')]: { nlink: 2 },
      [join(DATA, 'b.esp')]: { nlink: 2 },
    })
    const broken: VerifyIo = {
      ...io,
      lstat: (p) => {
        if (p.endsWith('a.esp')) throw new Error('EPERM')
        return io.lstat(p)
      },
    }
    const r = verifyDeployedInstance(DATA, broken)
    expect(r.missingCount).toBe(1)
    expect(r.intactFiles).toBe(1)
  })
})
