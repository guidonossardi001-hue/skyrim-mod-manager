import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, isAbsolute } from 'path'
import { parsePluginsTxt } from '../../src/lib/compatibility'

// MO2 profile resolution. Supports BOTH layouts:
//  - PORTABLE: ModOrganizer.ini sits next to ModOrganizer.exe; profiles under <exe>/profiles.
//  - INSTANCE (MO2 default): config under %LOCALAPPDATA%/ModOrganizer/<instance>/; the
//    current instance is recorded in %LOCALAPPDATA%/ModOrganizer/ModOrganizer.ini.
// Pure parsers are unit-tested; fs lookups are best-effort (never throw into pre-flight).

/** BOM-tolerant text read (MO2 files are usually UTF-8, but handle UTF-16 LE/BE). */
function readText(path: string): string {
  const buf = readFileSync(path)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.toString('utf16le').replace(/^\uFEFF/, '')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf)
    b.swap16()
    return b.toString('utf16le').replace(/^\uFEFF/, '')
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '')
}

function unwrap(v: string): string {
  let s = v.trim()
  const ba = s.match(/^@ByteArray\((.*)\)$/)
  if (ba) s = ba[1]
  return s.trim().replace(/^"(.*)"$/, '$1')
}

function iniValue(content: string, key: string): string | null {
  const m = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'im'))
  return m ? unwrap(m[1]) || null : null
}

export function parseSelectedProfile(iniContent: string): string | null {
  return iniValue(iniContent, 'selected_profile')
}
/** Raw value (may contain %BASE_DIR%); substitution happens during resolution. */
export function parseProfilesDirectory(iniContent: string): string | null {
  return iniValue(iniContent, 'profiles_directory')
}
export function parseCurrentInstance(iniContent: string): string | null {
  return iniValue(iniContent, 'CurrentInstance')
}

/** Reject names that could escape the profiles directory. */
function safeName(name: string | null): name is string {
  return !!name && !/[\\/]/.test(name) && !name.includes('..')
}

export interface Mo2Base {
  base: string
  iniPath: string
}

/** Resolve the MO2 config base (portable next to exe, else the active instance). */
export function resolveMo2Base(mo2ExePath: string | null, localAppData: string | null): Mo2Base | null {
  if (!mo2ExePath || !existsSync(mo2ExePath)) return null
  const exeDir = dirname(mo2ExePath)
  const portableIni = join(exeDir, 'ModOrganizer.ini')
  if (existsSync(portableIni)) return { base: exeDir, iniPath: portableIni } // portable

  if (!localAppData) return null
  const moRoot = join(localAppData, 'ModOrganizer')
  const rootIni = join(moRoot, 'ModOrganizer.ini')
  let instance: string | null = null
  try {
    if (existsSync(rootIni)) instance = parseCurrentInstance(readText(rootIni))
  } catch {
    /* */
  }
  if (!safeName(instance)) {
    try {
      instance =
        readdirSync(moRoot)
          .filter((d) => {
            try {
              return statSync(join(moRoot, d)).isDirectory()
            } catch {
              return false
            }
          })
          .map((d) => ({ d, m: statSync(join(moRoot, d)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0]?.d ?? null
    } catch {
      /* */
    }
  }
  if (!safeName(instance)) return null
  const base = join(moRoot, instance)
  return { base, iniPath: join(base, 'ModOrganizer.ini') }
}

export interface Mo2Plugins {
  profile: string | null
  pluginsPath: string | null
  plugins: { name: string; enabled: boolean }[]
}

export function resolveMo2Plugins(
  mo2ExePath: string | null,
  opts?: { localAppData?: string | null },
): Mo2Plugins {
  const empty: Mo2Plugins = { profile: null, pluginsPath: null, plugins: [] }
  try {
    const localAppData = opts?.localAppData ?? process.env.LOCALAPPDATA ?? null
    const resolved = resolveMo2Base(mo2ExePath, localAppData)
    if (!resolved) return empty
    const { base, iniPath } = resolved

    let profile: string | null = null
    let profilesDir = join(base, 'profiles')
    if (existsSync(iniPath)) {
      const ini = readText(iniPath)
      profile = parseSelectedProfile(ini)
      const custom = parseProfilesDirectory(ini)
      if (custom) {
        const cleaned = custom.replace(/%BASE_DIR%/gi, base)
        profilesDir = isAbsolute(cleaned) ? cleaned : join(base, cleaned.replace(/^[/\\]+/, ''))
      }
    }
    if (!existsSync(profilesDir)) return empty
    if (!safeName(profile)) profile = newestProfile(profilesDir)
    if (!safeName(profile)) return empty

    const pluginsPath = join(profilesDir, profile, 'plugins.txt')
    if (!existsSync(pluginsPath)) return { profile, pluginsPath: null, plugins: [] }
    return { profile, pluginsPath, plugins: parsePluginsTxt(readText(pluginsPath)) }
  } catch {
    return empty
  }
}

/** Newest profile ranked by its plugins.txt mtime (last actually used). */
function newestProfile(profilesDir: string): string | null {
  try {
    return (
      readdirSync(profilesDir)
        .map((d) => {
          const p = join(profilesDir, d, 'plugins.txt')
          try {
            return existsSync(p) ? { d, m: statSync(p).mtimeMs } : null
          } catch {
            return null
          }
        })
        .filter((x): x is { d: string; m: number } => !!x)
        .sort((a, b) => b.m - a.m)[0]?.d ?? null
    )
  } catch {
    return null
  }
}
