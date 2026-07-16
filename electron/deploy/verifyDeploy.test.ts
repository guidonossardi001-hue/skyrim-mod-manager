import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { verifyDeployedInstance, hasDeployDrift, type VerifyIo } from './verifyDeploy'
import { DEPLOY_MANIFEST_FILE } from './plan'

const DATA = 'C:\\game\\Data'

function manifestJson(files: string[], junctions: string[] = []): string {
  return JSON.stringify({ version: 1, target: DATA, files, junctions })
}

interface FakeEntry {
  nlink?: number
  dir?: boolean
}

function fakeIo(manifest: string | null, disk: Record<string, FakeEntry>): VerifyIo {
  const manifestPath = join(DATA, DEPLOY_MANIFEST_FILE)
  return {
    exists: (p) => (p === manifestPath ? manifest !== null : p in disk),
    readFile: (p) => {
      if (p === manifestPath && manifest !== null) return manifest
      throw new Error('ENOENT')
    },
    lstat: (p) => {
      const e = disk[p]
      if (!e) return null
      return { nlink: e.nlink ?? 2, isFile: !e.dir, isDirectory: !!e.dir }
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
