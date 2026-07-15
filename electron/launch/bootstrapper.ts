import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { SKYRIM_SE_APPID } from '../steam/detect'

// Modular BOOTSTRAPPER abstraction — the swappable "how the modded game is
// started" layer. The launch pipeline resolves ONE target from an ordered
// registry and never hard-codes SKSE/MO2: to change the launch method (add a
// proprietary loader, force MO2, etc.) you only edit the registry array, nothing
// else in the pipeline moves. Every bootstrapper is Electron-free and pure over an
// injected `exists`, so the whole resolution logic is unit-testable with fakes.
//
// Two launch modes:
//   • 'exe'      — spawn a resolved executable (SKSE loader / MO2). The main
//                  process runs it DETACHED so it survives the launcher closing.
//   • 'protocol' — hand off to a URI (steam://run/489830). Steam becomes the
//                  parent, so overlay/achievements/playtime keep working, and no
//                  SkyrimSE.exe is launched directly — the sanctioned mechanism
//                  for a legitimate copy.

export interface BootstrapContext {
  gamePath: string | null
  mo2Path: string | null
  steamAppId?: number // defaults to Skyrim SE/AE (489830)
}

export type BootstrapMode = 'exe' | 'protocol'

export interface BootstrapTarget {
  bootstrapperId: string
  bootstrapperName: string
  mode: BootstrapMode
  // mode === 'exe'
  exe?: string
  cwd?: string
  args?: string[]
  // mode === 'protocol'
  uri?: string
  description: string // human-facing summary of what will run
}

export interface Bootstrapper {
  id: string
  name: string
  /** Is this method available in the given environment? */
  detect(ctx: BootstrapContext, exists: (p: string) => boolean): boolean
  /** Concrete launch descriptor, or null if it cannot build one. */
  resolve(ctx: BootstrapContext): BootstrapTarget | null
}

function appId(ctx: BootstrapContext): number {
  return ctx.steamAppId ?? SKYRIM_SE_APPID
}

// ── MO2 ──────────────────────────────────────────────────────────────────────
// Highest priority when configured: MO2 owns the VFS and launches SKSE itself,
// and Steam still tracks the game because MO2 runs it under the Steam session.
export const mo2Bootstrapper: Bootstrapper = {
  id: 'mo2',
  name: 'Mod Organizer 2',
  detect: (ctx, exists) => !!ctx.mo2Path && /modorganizer\.exe$/i.test(ctx.mo2Path) && exists(ctx.mo2Path),
  resolve: (ctx) =>
    ctx.mo2Path
      ? {
          bootstrapperId: 'mo2',
          bootstrapperName: 'Mod Organizer 2',
          mode: 'exe',
          exe: ctx.mo2Path,
          cwd: dirname(ctx.mo2Path),
          args: [],
          description: 'Avvio tramite Mod Organizer 2 (VFS + SKSE, integrazione Steam preservata)',
        }
      : null,
}

// ── SKSE ─────────────────────────────────────────────────────────────────────
// The primary script-extender bootstrapper: skse64_loader.exe next to the game
// launches SkyrimSE under Steam with the extender loaded — full modded runtime.
export const skseBootstrapper: Bootstrapper = {
  id: 'skse',
  name: 'SKSE64',
  detect: (ctx, exists) => !!ctx.gamePath && exists(join(ctx.gamePath, 'skse64_loader.exe')),
  resolve: (ctx) =>
    ctx.gamePath
      ? {
          bootstrapperId: 'skse',
          bootstrapperName: 'SKSE64',
          mode: 'exe',
          exe: join(ctx.gamePath, 'skse64_loader.exe'),
          cwd: ctx.gamePath,
          args: [],
          description: 'Avvio tramite Skyrim Script Extender (skse64_loader.exe)',
        }
      : null,
}

// ── DragonLoader (proprietary fallback) ──────────────────────────────────────
// Last-resort loader when no script extender is present. It does NOT touch
// SkyrimSE.exe directly — it hands off to Steam's own launch mechanism
// (steam://run/<appid>), which is the sanctioned way to start a legitimate copy.
// Deployed mods still load; SKSE-dependent plugins do not (no extender). Always
// available once the Skyrim install is resolved, so the pipeline can never end up
// with "no way to launch".
export const dragonLoaderBootstrapper: Bootstrapper = {
  id: 'dragonloader',
  name: 'DragonLoader',
  detect: (ctx) => !!ctx.gamePath,
  resolve: (ctx) => ({
    bootstrapperId: 'dragonloader',
    bootstrapperName: 'DragonLoader',
    mode: 'protocol',
    uri: `steam://run/${appId(ctx)}`,
    description:
      'Avvio tramite il meccanismo Steam legittimo (steam://run) — overlay, achievement e playtime attivi. Senza script extender.',
  }),
}

// Priority order = the swap point. Reorder / replace to change the launch method
// project-wide without touching the pipeline or the IPC layer.
//
// DIRETTIVA DI PROGETTO (2026-07-15): il gioco moddato si avvia ESCLUSIVAMENTE tramite
// questo launcher col suo SKSE interno — MO2 è rimosso dal registry di default (il suo
// bootstrapper resta esportato sopra per chi volesse re-inserirlo in un registry custom).
// DragonLoader resta il fallback sanzionato (steam://run) quando SKSE manca.
export const DEFAULT_BOOTSTRAPPERS: Bootstrapper[] = [skseBootstrapper, dragonLoaderBootstrapper]

/** All bootstrappers currently available in this environment, in priority order. */
export function listAvailableBootstrappers(
  ctx: BootstrapContext,
  registry: Bootstrapper[] = DEFAULT_BOOTSTRAPPERS,
  exists: (p: string) => boolean = existsSync,
): Bootstrapper[] {
  return registry.filter((b) => b.detect(ctx, exists))
}

/** First available bootstrapper's launch target (priority order), or null if none. */
export function resolveBootstrapper(
  ctx: BootstrapContext,
  registry: Bootstrapper[] = DEFAULT_BOOTSTRAPPERS,
  exists: (p: string) => boolean = existsSync,
): BootstrapTarget | null {
  for (const b of registry) {
    if (b.detect(ctx, exists)) {
      const t = b.resolve(ctx)
      if (t) return t
    }
  }
  return null
}
