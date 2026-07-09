import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import {
  detect7zPath,
  parse7zVersion,
  looksLike7z,
  COMMON_7Z_PATHS,
  bundled7zaPath,
  toUnpackedPath,
  resolveRar7z,
  bundledFull7zPath,
} from './sevenZip'

describe('7-Zip discovery', () => {
  it('returns the configured path when it exists', () => {
    const exists = (p: string) => p === 'D:/tools/7z.exe'
    expect(detect7zPath(exists, 'D:/tools/7z.exe')).toBe('D:/tools/7z.exe')
  })

  it('falls back to a known install location when the configured path is missing', () => {
    const exists = (p: string) => p === COMMON_7Z_PATHS[0]
    expect(detect7zPath(exists, 'D:/nope/7z.exe')).toBe(COMMON_7Z_PATHS[0])
    expect(detect7zPath(exists, undefined)).toBe(COMMON_7Z_PATHS[0])
  })

  it('returns null when nothing is found', () => {
    expect(detect7zPath(() => false, 'X:/missing.exe')).toBeNull()
  })
})

describe('bundled 7za (no-config default engine)', () => {
  it('redirects an app.asar path to app.asar.unpacked, no-op otherwise', () => {
    expect(toUnpackedPath('C:/app/resources/app.asar/node_modules/7zip-bin/win/x64/7za.exe')).toBe(
      'C:/app/resources/app.asar.unpacked/node_modules/7zip-bin/win/x64/7za.exe',
    )
    expect(toUnpackedPath('C:/dev/node_modules/7zip-bin/win/x64/7za.exe')).toBe(
      'C:/dev/node_modules/7zip-bin/win/x64/7za.exe',
    )
  })

  it('resolves to a real, existing bundled binary in dev', () => {
    const p = bundled7zaPath()
    expect(p).toMatch(/7za/i)
    expect(existsSync(p)).toBe(true) // shipped via 7zip-bin
  })
})

describe('full 7-Zip resolution for .rar', () => {
  const SYS = COMMON_7Z_PATHS[0]

  it('prefers a system install (detect7zPath) as the primary interpreter', () => {
    const exists = (p: string) => p === SYS // only the system 7z exists
    expect(resolveRar7z(undefined, exists)).toBe(SYS)
  })

  it('honours a configured override before the common locations', () => {
    const exists = (p: string) => p === 'D:/tools/7z.exe' || p === SYS
    expect(resolveRar7z('D:/tools/7z.exe', exists)).toBe('D:/tools/7z.exe')
  })

  it('falls back to the bundled full 7z when no system install exists', () => {
    const bundled = bundledFull7zPath() // real repo resource
    expect(bundled).toBeTruthy()
    const exists = (p: string) => p === bundled // no system, only bundled
    expect(resolveRar7z(undefined, exists)).toBe(bundled)
  })

  it('returns null only when neither system nor bundled is available', () => {
    expect(resolveRar7z(undefined, () => false)).toBeNull()
  })

  it('ships the bundled full 7z as a real repo resource', () => {
    const p = bundledFull7zPath()
    expect(p).toBeTruthy()
    expect(existsSync(p!)).toBe(true)
  })
})

describe('7-Zip identity', () => {
  it('parses the version from the banner', () => {
    expect(parse7zVersion('7-Zip 24.07 (x64) : Copyright (c) 1999-2024 Igor Pavlov')).toBe('24.07')
    expect(parse7zVersion('7-Zip (a) 19.00')).toBe('19.00')
    expect(parse7zVersion('some random exe output')).toBeNull()
  })

  it('recognises a real 7-Zip banner vs an arbitrary binary', () => {
    expect(looksLike7z('7-Zip 24.07 (x64)')).toBe(true)
    expect(looksLike7z('WinRAR 7.00')).toBe(false)
  })
})
