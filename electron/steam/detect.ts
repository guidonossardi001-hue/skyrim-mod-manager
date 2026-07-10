import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { getLibraryPaths, parseAppManifest, parseVdf } from './vdf'
import { parseAddressLibVersion, parseSkseRuntimeVersion, gameVersionSupported } from './version'

// COMPANION MODE Steam probe — strictly read-only. Detects the Steam install,
// extra library folders, and whether Skyrim SE/AE (AppID 489830) is installed.
// Never writes to or launches Steam; only inspects local files/registry/process.

export const SKYRIM_SE_APPID = 489830

// Absolute System32 paths: invoking reg/tasklist by BARE name lets a planted reg.exe /
// tasklist.exe on PATH or in the current directory run instead of the real Windows tool
// (binary-planting). Resolve them from %SystemRoot% once.
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const REG_EXE = join(SYS32, 'reg.exe')
const TASKLIST_EXE = join(SYS32, 'tasklist.exe')

export interface SteamInfo {
  installed: boolean
  running: boolean
  path: string | null
  libraries: string[]
}
export interface SkyrimInfo {
  appId: number
  installed: boolean
  path: string | null
  version: string | null
}

function regQuery(key: string, value: string): string | null {
  try {
    const out = execFileSync(REG_EXE, ['query', key, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    const m = out.match(new RegExp(`${value}\\s+REG_SZ\\s+(.+)`, 'i'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export function getSteamPath(): string | null {
  const fromReg =
    regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath') ??
    regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')
  const candidates = [fromReg, 'C:/Program Files (x86)/Steam', 'C:/Program Files/Steam'].filter(
    Boolean,
  ) as string[]
  for (const c of candidates) {
    const p = c.replace(/\\/g, '/')
    if (existsSync(join(p, 'steam.exe')) || existsSync(join(p, 'steamapps'))) return p
  }
  return null
}

export function getLibraries(steamPath: string): string[] {
  const libs = new Set<string>([steamPath])
  const vdfPath = join(steamPath, 'steamapps', 'libraryfolders.vdf')
  if (existsSync(vdfPath)) {
    try {
      for (const p of getLibraryPaths(parseVdfFile(vdfPath))) libs.add(p)
    } catch {
      /* ignore */
    }
  }
  return [...libs]
}

function parseVdfFile(path: string) {
  return parseVdf(readFileSync(path, 'utf8'))
}

export function isSteamRunning(): boolean {
  try {
    const out = execFileSync(TASKLIST_EXE, ['/FI', 'IMAGENAME eq steam.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    return /steam\.exe/i.test(out)
  } catch {
    return false
  }
}

export function findSkyrim(libraries: string[]): SkyrimInfo {
  for (const lib of libraries) {
    const manifest = join(lib, 'steamapps', `appmanifest_${SKYRIM_SE_APPID}.acf`)
    if (!existsSync(manifest)) continue
    try {
      const m = parseAppManifest(readFileSync(manifest, 'utf8'))
      const installdir = m?.installdir ?? 'Skyrim Special Edition'
      const gamePath = join(lib, 'steamapps', 'common', installdir).replace(/\\/g, '/')
      if (existsSync(gamePath)) {
        return {
          appId: SKYRIM_SE_APPID,
          installed: true,
          path: gamePath,
          version: readSkyrimVersion(gamePath),
        }
      }
    } catch {
      /* try next library */
    }
  }
  return { appId: SKYRIM_SE_APPID, installed: false, path: null, version: null }
}

// Runtime version from the Address Library bin filename (no PE header parsing).
// If multiple bins are present (e.g. SE 1.5 + AE 1.6), pick the HIGHEST version.
export function readSkyrimVersion(gamePath: string): string | null {
  try {
    const dir = join(gamePath, 'Data', 'SKSE', 'Plugins')
    if (!existsSync(dir)) return null
    const versions = readdirSync(dir)
      .map(parseAddressLibVersion)
      .filter((v): v is string => !!v)
    if (versions.length === 0) return null
    return versions.sort((a, b) => {
      const pa = a.split('.').map(Number),
        pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0)
        if (d !== 0) return d
      }
      return 0
    })[0]
  } catch {
    return null
  }
}

export interface SkseInfo {
  present: boolean
  version: string | null
  gameVersion: string | null
  gameVersionSupported: boolean | null
}

// SKSE detection + game-version compatibility (T5): the SKSE runtime DLL
// (skse64_<build>.dll) in the game root encodes the game build it targets;
// matching it against the installed runtime tells us if SKSE will actually load.
export function detectSkse(gamePath: string | null): SkseInfo {
  if (!gamePath || !existsSync(gamePath))
    return { present: false, version: null, gameVersion: null, gameVersionSupported: null }
  const present = existsSync(join(gamePath, 'skse64_loader.exe'))
  const gameVersion = readSkyrimVersion(gamePath)
  let version: string | null = null
  try {
    const dll = readdirSync(gamePath).find((n) => /^skse64_\d+_\d+_\d+\.dll$/i.test(n))
    if (dll) version = parseSkseRuntimeVersion(dll)
  } catch {
    /* best-effort */
  }
  return { present, version, gameVersion, gameVersionSupported: gameVersionSupported(gameVersion, version) }
}

export function detectSteamEnv(): { steam: SteamInfo; skyrim: SkyrimInfo } {
  const path = getSteamPath()
  if (!path) {
    return {
      steam: { installed: false, running: false, path: null, libraries: [] },
      skyrim: { appId: SKYRIM_SE_APPID, installed: false, path: null, version: null },
    }
  }
  const libraries = getLibraries(path)
  return {
    steam: { installed: true, running: isSteamRunning(), path, libraries },
    skyrim: findSkyrim(libraries),
  }
}
