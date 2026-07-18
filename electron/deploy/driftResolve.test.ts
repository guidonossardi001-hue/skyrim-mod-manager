import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { loadAcceptedOverrides, resolveDriftedFile, ACCEPTED_OVERRIDES_FILE, type DriftResolveIo } from './driftResolve'

const DATA = 'C:\\game\\Data'

function fakeIo(initial: Record<string, string> = {}): DriftResolveIo & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial }
  return {
    files,
    exists: (p) => p in files,
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFileAtomic: (p, data) => {
      files[p] = String(data)
    },
    unlink: (p) => {
      delete files[p]
    },
    mkdir: () => {},
    link: (src, dest) => {
      files[dest] = `LINK:${src}`
    },
  }
}

describe('loadAcceptedOverrides', () => {
  it('nessun sidecar → set vuoto', () => {
    expect(loadAcceptedOverrides(DATA, fakeIo())).toEqual(new Set())
  })

  it('sidecar valido → set dei rel', () => {
    const io = fakeIo({ [join(DATA, ACCEPTED_OVERRIDES_FILE)]: JSON.stringify(['a.esp', 'b.esp']) })
    expect(loadAcceptedOverrides(DATA, io)).toEqual(new Set(['a.esp', 'b.esp']))
  })

  it('sidecar corrotto → set vuoto, mai throw', () => {
    const io = fakeIo({ [join(DATA, ACCEPTED_OVERRIDES_FILE)]: 'not-json' })
    expect(loadAcceptedOverrides(DATA, io)).toEqual(new Set())
  })

  it('sidecar con entry non-stringa → filtrate', () => {
    const io = fakeIo({ [join(DATA, ACCEPTED_OVERRIDES_FILE)]: JSON.stringify(['a.esp', 7, null]) })
    expect(loadAcceptedOverrides(DATA, io)).toEqual(new Set(['a.esp']))
  })
})

describe('resolveDriftedFile — accept', () => {
  it('aggiunge il rel al sidecar (creandolo se assente)', () => {
    const io = fakeIo()
    const r = resolveDriftedFile(DATA, 'a.esp', 'file', 'accept', null, io)
    expect(r).toEqual({ ok: true, action: 'accept', rel: 'a.esp' })
    expect(loadAcceptedOverrides(DATA, io)).toEqual(new Set(['a.esp']))
  })

  it('accumula senza perdere rel già accettati', () => {
    const io = fakeIo({ [join(DATA, ACCEPTED_OVERRIDES_FILE)]: JSON.stringify(['a.esp']) })
    resolveDriftedFile(DATA, 'textures\\big', 'junction', 'accept', null, io)
    expect(loadAcceptedOverrides(DATA, io)).toEqual(new Set(['a.esp', 'textures\\big']))
  })
})

describe('resolveDriftedFile — restore', () => {
  it('kind:file con sorgente risolta → elimina l’esterno e crea il link gestito', () => {
    const dest = join(DATA, 'a.esp')
    const io = fakeIo({ [dest]: 'contenuto-esterno' })
    const r = resolveDriftedFile(DATA, 'a.esp', 'file', 'restore', { src: 'C:\\mods\\ModA\\a.esp' }, io)
    expect(r).toEqual({ ok: true, action: 'restore', rel: 'a.esp' })
    expect(io.files[dest]).toBe('LINK:C:\\mods\\ModA\\a.esp')
  })

  it('kind:file senza sorgente risolta (mod rimossa/disabilitata) → ok:false, nessuna scrittura', () => {
    const dest = join(DATA, 'a.esp')
    const io = fakeIo({ [dest]: 'contenuto-esterno' })
    const r = resolveDriftedFile(DATA, 'a.esp', 'file', 'restore', null, io)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/nessuna mod/i)
    expect(io.files[dest]).toBe('contenuto-esterno') // intatto: nessuna azione distruttiva su fallimento
  })

  it('kind:junction → sempre ok:false, indirizza a un Deploy completo', () => {
    const r = resolveDriftedFile(DATA, 'textures\\big', 'junction', 'restore', { src: 'C:\\mods\\X\\textures\\big' }, fakeIo())
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/deploy completo/i)
  })
})
