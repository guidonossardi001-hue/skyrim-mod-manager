import { describe, it, expect } from 'vitest'
import { resolveFormKey, isLightSpace, type FormKeyContext } from './formKey'

const lightMap = new Map<string, boolean>([
  ['skyrim.esm', false],
  ['update.esm', false],
  ['lightmaster.esp', true],
])
const ctx = (pluginName: string, masters: string[]): FormKeyContext => ({
  pluginName,
  masters,
  isLight: (n) => lightMap.get(n.toLowerCase()),
})

describe('resolveFormKey', () => {
  it('override: byte alto = indice MAST, origine = master, mask 24 bit', () => {
    const r = resolveFormKey(0x00_012eb7, ctx('Mod.esp', ['Skyrim.esm', 'Update.esm']))
    expect(r).toEqual({ key: 'skyrim.esm|012eb7', origin: 'Skyrim.esm', isOwn: false, objectIndex: 0x012eb7 })
  })

  it('indice = masters.length → record PROPRIO, origine = il plugin stesso', () => {
    const r = resolveFormKey(0x02_000d63, ctx('Mod.esp', ['Skyrim.esm', 'Update.esm']))
    expect(r.isOwn).toBe(true)
    expect(r.origin).toBe('Mod.esp')
    expect(r.key).toBe('mod.esp|000d63')
  })

  it('indice OLTRE masters.length (file sloppy) → trattato come proprio, mai crash', () => {
    const r = resolveFormKey(0x07_000001, ctx('Mod.esp', ['Skyrim.esm']))
    expect(r.isOwn).toBe(true)
    expect(r.origin).toBe('Mod.esp')
  })

  it('origine light: mask 12 bit (difesa contro upper bit sporchi nei riferimenti ESL)', () => {
    const r = resolveFormKey(0x00_000801, ctx('Dependent.esp', ['LightMaster.esp']))
    expect(r.key).toBe('lightmaster.esp|000801')
    const dirty = resolveFormKey(0x00_abc801, ctx('Dependent.esp', ['LightMaster.esp']))
    expect(dirty.key).toBe('lightmaster.esp|000801') // upper bit ignorati, stessa identità
  })

  it('estensione .esl forza light anche con flag sconosciuto', () => {
    const r = resolveFormKey(0x00_fff923, ctx('Dep.esp', ['ccKit.esl']))
    expect(r.objectIndex).toBe(0x923)
    expect(r.key).toBe('cckit.esl|000923')
  })

  it('origine sconosciuta alla mappa light → mask 24 bit (mai collassare un full)', () => {
    const r = resolveFormKey(0x00_123456, ctx('Dep.esp', ['Unknown.esm']))
    expect(r.objectIndex).toBe(0x123456)
  })

  it('la chiave è case-insensitive sul nome file (identità Windows)', () => {
    const a = resolveFormKey(0x00_000001, ctx('Dep.esp', ['SKYRIM.ESM']))
    const b = resolveFormKey(0x00_000001, ctx('Other.esp', ['skyrim.esm']))
    expect(a.key).toBe(b.key)
  })
})

describe('isLightSpace', () => {
  it('.esl forza light; altrimenti decide il flag header', () => {
    expect(isLightSpace('a.esl', undefined)).toBe(true)
    expect(isLightSpace('a.esl', false)).toBe(true)
    expect(isLightSpace('a.esp', true)).toBe(true)
    expect(isLightSpace('a.esp', false)).toBe(false)
    expect(isLightSpace('a.esp', undefined)).toBe(false)
  })
})
