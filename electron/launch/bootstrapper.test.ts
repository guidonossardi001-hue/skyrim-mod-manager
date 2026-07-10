import { describe, it, expect } from 'vitest'
import {
  resolveBootstrapper,
  listAvailableBootstrappers,
  DEFAULT_BOOTSTRAPPERS,
  type BootstrapContext,
} from './bootstrapper'

const G = 'C:/Games/Skyrim Special Edition'
const MO2 = 'C:/Tools/MO2/ModOrganizer.exe'

// Injected filesystem: only the listed paths "exist".
const existsFrom = (present: string[]) => (p: string) => present.includes(p.replace(/\\/g, '/'))

describe('resolveBootstrapper', () => {
  it('prefers MO2 when configured and present', () => {
    const ctx: BootstrapContext = { gamePath: G, mo2Path: MO2 }
    const t = resolveBootstrapper(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([MO2, `${G}/skse64_loader.exe`]))
    expect(t?.bootstrapperId).toBe('mo2')
    expect(t?.mode).toBe('exe')
    expect(t?.exe).toBe(MO2)
  })

  it('falls back to SKSE when MO2 absent but loader present', () => {
    const ctx: BootstrapContext = { gamePath: G, mo2Path: null }
    const t = resolveBootstrapper(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([`${G}/skse64_loader.exe`]))
    expect(t?.bootstrapperId).toBe('skse')
    expect(t?.exe?.replace(/\\/g, '/')).toBe(`${G}/skse64_loader.exe`)
    expect(t?.cwd).toBe(G)
  })

  it('falls back to DragonLoader (steam://run) when no extender is installed', () => {
    const ctx: BootstrapContext = { gamePath: G, mo2Path: null }
    const t = resolveBootstrapper(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([])) // nothing on disk
    expect(t?.bootstrapperId).toBe('dragonloader')
    expect(t?.mode).toBe('protocol')
    expect(t?.uri).toBe('steam://run/489830')
  })

  it('honors a custom appid in the DragonLoader URI', () => {
    const ctx: BootstrapContext = { gamePath: G, mo2Path: null, steamAppId: 12345 }
    const t = resolveBootstrapper(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([]))
    expect(t?.uri).toBe('steam://run/12345')
  })

  it('ignores an MO2 path that is not ModOrganizer.exe', () => {
    const bogus = 'C:/Tools/MO2/notmo2.exe'
    const ctx: BootstrapContext = { gamePath: G, mo2Path: bogus }
    const t = resolveBootstrapper(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([bogus, `${G}/skse64_loader.exe`]))
    expect(t?.bootstrapperId).toBe('skse') // MO2 rejected on name, SKSE wins
  })

  it('returns null when no game is resolved and MO2 is absent', () => {
    const ctx: BootstrapContext = { gamePath: null, mo2Path: null }
    expect(resolveBootstrapper(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([]))).toBeNull()
  })

  it('is swappable via a custom registry (order is the swap point)', () => {
    // Force SKSE-first: DragonLoader only when SKSE truly missing.
    const ctx: BootstrapContext = { gamePath: G, mo2Path: MO2 }
    const registry = DEFAULT_BOOTSTRAPPERS.filter((b) => b.id !== 'mo2')
    const t = resolveBootstrapper(ctx, registry, existsFrom([MO2, `${G}/skse64_loader.exe`]))
    expect(t?.bootstrapperId).toBe('skse')
  })
})

describe('listAvailableBootstrappers', () => {
  it('reports every method available, in priority order', () => {
    const ctx: BootstrapContext = { gamePath: G, mo2Path: MO2 }
    const ids = listAvailableBootstrappers(
      ctx,
      DEFAULT_BOOTSTRAPPERS,
      existsFrom([MO2, `${G}/skse64_loader.exe`]),
    ).map((b) => b.id)
    expect(ids).toEqual(['mo2', 'skse', 'dragonloader'])
  })

  it('drops methods whose files are missing', () => {
    const ctx: BootstrapContext = { gamePath: G, mo2Path: null }
    const ids = listAvailableBootstrappers(ctx, DEFAULT_BOOTSTRAPPERS, existsFrom([])).map((b) => b.id)
    expect(ids).toEqual(['dragonloader']) // only the steam://run fallback
  })
})
