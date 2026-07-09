import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import {
  isPathInside,
  assertNoZipSlip,
  parse7zProgress,
  sha256File,
  verifyArchiveHash,
  extractArchive,
} from './extract'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smm-extract-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extract: pure guards', () => {
  it('isPathInside accepts contained paths and rejects traversal', () => {
    expect(isPathInside('/mods/x', '/mods/x/foo/bar.esp')).toBe(true)
    expect(isPathInside('/mods/x', '/mods/x')).toBe(true)
    expect(isPathInside('/mods/x', '/mods/x/../../etc/passwd')).toBe(false)
    expect(isPathInside('/mods/x', '/mods/xyz/sneaky')).toBe(false) // sibling prefix, not inside
  })

  it('parse7zProgress takes the last percentage on a line', () => {
    expect(parse7zProgress(' 12% 3 - a.esp')).toBe(12)
    expect(parse7zProgress('  7% - x  42% - y')).toBe(42)
    expect(parse7zProgress('no progress here')).toBeNull()
    expect(parse7zProgress('999%')).toBeNull()
  })
})

describe('extract: streaming hash', () => {
  it('computes sha256 by streaming and verifies match/mismatch', async () => {
    const f = join(dir, 'a.bin')
    const content = Buffer.from('the quick brown fox')
    writeFileSync(f, content)
    const expected = createHash('sha256').update(content).digest('hex')
    expect(await sha256File(f)).toBe(expected)
    expect((await verifyArchiveHash(f, expected)).ok).toBe(true)
    expect((await verifyArchiveHash(f, 'deadbeef')).ok).toBe(false)
  })
})

describe('extract: zip fallback safety', () => {
  it('extracts a benign zip when 7-Zip is absent', async () => {
    const zip = new AdmZip()
    zip.addFile('foo/bar.esp', Buffer.from('hi'))
    const arc = join(dir, 'm.zip')
    zip.writeZip(arc)
    const out = join(dir, 'out')
    const r = await extractArchive(arc, out) // no sevenZipPath → adm-zip
    expect(r.method).toBe('zip')
    expect(existsSync(join(out, 'foo', 'bar.esp'))).toBe(true)
  })

  it('zip-slip guard rejects traversal entries and accepts contained ones', () => {
    // Tested directly: adm-zip happens to sanitize names on write, but the guard is
    // our authoritative defense and must hold for ANY entry list (other zip libs/raw zips).
    const out = join(dir, 'out')
    expect(() => assertNoZipSlip(['../evil.txt'], out)).toThrow(/zip-slip/i)
    expect(() => assertNoZipSlip(['a/b.esp', 'c.esp'], out)).not.toThrow()
    expect(() => assertNoZipSlip(['foo/../../../etc/passwd'], out)).toThrow(/zip-slip/i)
  })

  it('refuses a .zip above the in-memory size cap (OOM guard)', async () => {
    const zip = new AdmZip()
    zip.addFile('a.esp', Buffer.from('x'.repeat(1000)))
    const arc = join(dir, 'big.zip')
    zip.writeZip(arc)
    await expect(extractArchive(arc, join(dir, 'out'), { admZipMaxBytes: 10 })).rejects.toThrow(
      /troppo grande/i,
    )
  })

  it('rejects .7z when no 7-Zip engine (system or bundled) is provided', async () => {
    const arc = join(dir, 'm.7z')
    writeFileSync(arc, Buffer.from('not really 7z'))
    await expect(extractArchive(arc, join(dir, 'out'))).rejects.toThrow(/Nessun estrattore/i)
  })

  it('rejects .rar when no full 7-Zip is available (bundled 7za lacks the Rar codec)', async () => {
    const arc = join(dir, 'm.rar')
    writeFileSync(arc, Buffer.from('x'))
    // only the standalone 7za given (no full7zPath) → must notify to install 7-Zip
    await expect(
      extractArchive(arc, join(dir, 'out'), { bundled7zaPath: 'C:/fake/7za.exe' }),
    ).rejects.toThrow(/\.rar non disponibile|nessun 7-Zip completo/i)
  })
})

describe('extract: atomic commit', () => {
  // These lock the crash-safety guarantee: a mod dir must appear COMPLETE or not at all.
  // Regression guard — a future refactor that unpacks straight into destDir breaks them.
  const mkZip = (name: string) => {
    const zip = new AdmZip()
    zip.addFile('foo/bar.esp', Buffer.from('hi'))
    const arc = join(dir, name)
    zip.writeZip(arc)
    return arc
  }

  it('leaves no .tmp sibling after a successful extract', async () => {
    const arc = mkZip('ok.zip')
    const out = join(dir, 'out')
    await extractArchive(arc, out)
    expect(existsSync(join(out, 'foo', 'bar.esp'))).toBe(true)
    expect(existsSync(out + '.tmp')).toBe(false) // committed, staging gone
  })

  it('creates neither destDir nor .tmp when extraction fails', async () => {
    const arc = mkZip('toobig.zip')
    const out = join(dir, 'out')
    await expect(extractArchive(arc, out, { admZipMaxBytes: 1 })).rejects.toThrow()
    // failure must NOT leave a half-written mod dir a resumed run would trust as "done"
    expect(existsSync(out)).toBe(false)
    expect(existsSync(out + '.tmp')).toBe(false)
  })

  it('discards a stale .tmp from a prior crash before extracting', async () => {
    const out = join(dir, 'out')
    const tmp = out + '.tmp'
    // simulate a crash mid-extract: leftover junk in the staging dir
    const { mkdirSync } = await import('node:fs')
    mkdirSync(tmp, { recursive: true })
    writeFileSync(join(tmp, 'garbage.dat'), 'partial')
    await extractArchive(mkZip('clean.zip'), out)
    expect(existsSync(join(out, 'foo', 'bar.esp'))).toBe(true)
    expect(existsSync(join(out, 'garbage.dat'))).toBe(false) // stale staging not merged
    expect(existsSync(tmp)).toBe(false)
  })

  it('replaces a pre-existing destDir on commit (no merge of old files)', async () => {
    const out = join(dir, 'out')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'old.esp'), 'previous version')
    await extractArchive(mkZip('new.zip'), out)
    expect(existsSync(join(out, 'foo', 'bar.esp'))).toBe(true)
    expect(existsSync(join(out, 'old.esp'))).toBe(false) // clean replace, not overlay
  })
})
