import { path7za } from '7zip-bin'
import { existsSync } from 'fs'
import { join } from 'path'

// 7-Zip discovery + identity helpers.
//   • The app BUNDLES a prebuilt standalone 7za (via 7zip-bin) so .7z/.zip/tar/gz/bz2
//     extract natively with ZERO user configuration (no C++ build — it is a shipped
//     binary, run in a child process off the UI thread).
//   • .rar needs the FULL system 7-Zip (the standalone 7za lacks the Rar codec); the
//     configured/auto-detected 7z.exe is used for that, with a clear message otherwise.

// In a packaged app the binary lives inside app.asar (not executable); electron-builder
// unpacks it to app.asar.unpacked (see asarUnpack), so we redirect the path there. In
// dev there is no app.asar segment, so this is a no-op. Pure → unit-testable.
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

/** Path to the bundled standalone 7za (handles .7z/.zip/tar/gz/bz2 — NOT .rar). */
export function bundled7zaPath(): string {
  return toUnpackedPath(path7za)
}

// Full 7-Zip (7z.exe + 7z.dll) shipped as an uncompressed external resource. Unlike
// the standalone 7za it DOES carry the Rar/Rar5 codec, so it is the .rar fallback when
// no system install is found. Shipped via electron-builder `extraResources` → lands in
// process.resourcesPath/7zip-full in production; the repo copy is used in dev/tests.
export function bundledFull7zCandidates(): string[] {
  const exe = process.platform === 'win32' ? '7z.exe' : '7z'
  const out: string[] = []
  if (typeof process.resourcesPath === 'string') out.push(join(process.resourcesPath, '7zip-full', exe))
  out.push(join(process.cwd(), 'resources', '7zip-full', exe))
  return out
}

export function bundledFull7zPath(exists: (p: string) => boolean = existsSync): string | null {
  return bundledFull7zCandidates().find(exists) ?? null
}

/**
 * Resolve the full 7-Zip to use for .rar: the system install identified by
 * detect7zPath (configured path or a common install location) is the PRIMARY
 * interpreter; the bundled full 7z is the fallback. Returns null only if neither
 * exists (caller then notifies the user).
 */
export function resolveRar7z(
  configured?: string | null,
  exists: (p: string) => boolean = existsSync,
): string | null {
  return detect7zPath(exists, configured) ?? bundledFull7zPath(exists)
}

export const COMMON_7Z_PATHS = [
  'C:/Program Files/7-Zip/7z.exe',
  'C:/Program Files (x86)/7-Zip/7z.exe',
  'C:/Program Files/7-Zip/7zG.exe',
]

/** Pick a usable 7z path: the configured one if it exists, else a known install location. */
export function detect7zPath(exists: (p: string) => boolean, configured?: string | null): string | null {
  if (configured && exists(configured)) return configured
  for (const p of COMMON_7Z_PATHS) if (exists(p)) return p
  return null
}

/** The 7-Zip banner looks like "7-Zip 24.07 (x64) : Copyright …". Extract the version. */
export function parse7zVersion(banner: string): string | null {
  const m = banner.match(/7-Zip[^\d]*([0-9]+\.[0-9]+)/i)
  return m ? m[1] : null
}

/** A real 7-Zip binary prints its name in the banner — distinguishes it from a random exe. */
export function looksLike7z(banner: string): boolean {
  return /7-Zip/i.test(banner)
}
