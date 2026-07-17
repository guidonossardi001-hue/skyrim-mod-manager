import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findFixedFileVersion, parseSectionHeaders, readPeFileVersion } from './peVersion'

/** VS_FIXEDFILEINFO minimale: firma + strucVersion + FileVersion MS/LS. */
function fixedFileInfo(a: number, b: number, c: number, d: number): Buffer {
  const buf = Buffer.alloc(52)
  buf.writeUInt32LE(0xfeef04bd, 0)
  buf.writeUInt32LE(0x00010000, 4)
  buf.writeUInt32LE(((a & 0xffff) << 16) | (b & 0xffff), 8)
  buf.writeUInt32LE(((c & 0xffff) << 16) | (d & 0xffff), 12)
  return buf
}

/** PE32+ sintetico con una sezione .rsrc che contiene il blob dato. */
function buildPe(rsrcContent: Buffer): Buffer {
  const peOff = 0x80
  const optSize = 240 // PE32+ standard
  const sectionsOff = peOff + 24 + optSize
  const rawPtr = 0x400
  const file = Buffer.alloc(rawPtr + rsrcContent.length)
  file.write('MZ', 0, 'ascii')
  file.writeUInt32LE(peOff, 0x3c)
  file.write('PE\0\0', peOff, 'ascii')
  file.writeUInt16LE(1, peOff + 6) // numberOfSections
  file.writeUInt16LE(optSize, peOff + 20)
  // Section header .rsrc
  file.write('.rsrc', sectionsOff, 'ascii')
  file.writeUInt32LE(rsrcContent.length, sectionsOff + 16) // rawSize
  file.writeUInt32LE(rawPtr, sectionsOff + 20) // rawPtr
  rsrcContent.copy(file, rawPtr)
  return file
}

const roots: string[] = []
afterAll(() => {
  for (const r of roots)
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
})

describe('findFixedFileVersion', () => {
  it('estrae a.b.c.d dalla firma + strucVersion', () => {
    const blob = Buffer.concat([Buffer.alloc(37, 0x11), fixedFileInfo(1, 6, 1170, 0)])
    expect(findFixedFileVersion(blob)).toBe('1.6.1170.0')
  })

  it('firma senza strucVersion valida → ignorata (collisione)', () => {
    const fake = Buffer.alloc(20)
    fake.writeUInt32LE(0xfeef04bd, 0)
    fake.writeUInt32LE(0xdeadbeef, 4)
    expect(findFixedFileVersion(fake)).toBeNull()
  })
})

describe('parseSectionHeaders', () => {
  it('trova la sezione .rsrc nel PE sintetico', () => {
    const pe = buildPe(Buffer.alloc(16))
    const sections = parseSectionHeaders(pe.subarray(0, 4096))!
    expect(sections.map((s) => s.name)).toContain('.rsrc')
  })

  it('non-PE → null', () => {
    expect(parseSectionHeaders(Buffer.from('non un exe'))).toBeNull()
    expect(parseSectionHeaders(Buffer.alloc(0))).toBeNull()
  })
})

describe('readPeFileVersion', () => {
  it('legge la FileVersion da un exe sintetico su disco (con cache su mtime)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smm-pe-'))
    roots.push(dir)
    const exe = join(dir, 'SkyrimSE.exe')
    writeFileSync(exe, buildPe(Buffer.concat([Buffer.alloc(64, 0), fixedFileInfo(1, 6, 1170, 0)])))
    expect(readPeFileVersion(exe)).toBe('1.6.1170.0')
    expect(readPeFileVersion(exe)).toBe('1.6.1170.0') // hit di cache
  })

  it('file assente o senza risorse → null, mai throw', () => {
    expect(readPeFileVersion('Z:/non/esiste.exe')).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'smm-pe-'))
    roots.push(dir)
    const noRsrc = join(dir, 'plain.exe')
    writeFileSync(noRsrc, Buffer.from('MZ solo testo'))
    expect(readPeFileVersion(noRsrc)).toBeNull()
  })
})
