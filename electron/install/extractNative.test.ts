import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundled7zaPath, bundledFull7zPath } from './sevenZip'
import { extractArchive } from './extract'

// End-to-end proof that the BUNDLED 7za extracts .7z/.zip natively with NO user
// configuration, streaming with progress. Skipped only if the platform binary is
// somehow absent (it ships via 7zip-bin).
const sevenZa = bundled7zaPath()
const haveBinary = existsSync(sevenZa)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smm-7z-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!haveBinary)('native extraction via bundled 7za (no system 7-Zip)', () => {
  // ~3 MB so 7-Zip emits real -bsp1 progress lines.
  function makePayload(): void {
    mkdirSync(join(dir, 'src', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'src', 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 42))
    writeFileSync(join(dir, 'src', 'sub', 'note.txt'), 'hello esp')
  }

  it('creates and extracts a .7z, emitting progress', async () => {
    makePayload()
    const arc = join(dir, 'mod.7z')
    const c = spawnSync(sevenZa, ['a', '-y', arc, 'src'], { cwd: dir })
    expect(c.status).toBe(0)

    let progressed = 0
    const r = await extractArchive(arc, join(dir, 'out'), {
      bundled7zaPath: sevenZa,
      onProgress: () => progressed++,
    })
    expect(r.method).toBe('7za') // used the bundled engine, not a system 7-Zip
    expect(existsSync(join(dir, 'out', 'src', 'big.bin'))).toBe(true)
    expect(readFileSync(join(dir, 'out', 'src', 'sub', 'note.txt'), 'utf8')).toBe('hello esp')
    expect(progressed).toBeGreaterThan(0)
  })

  it('extracts a .zip via the bundled engine (preferred over the in-memory fallback)', async () => {
    makePayload()
    const arc = join(dir, 'mod.zip')
    const c = spawnSync(sevenZa, ['a', '-y', '-tzip', arc, 'src'], { cwd: dir })
    expect(c.status).toBe(0)

    const r = await extractArchive(arc, join(dir, 'out'), { bundled7zaPath: sevenZa })
    expect(r.method).toBe('7za')
    expect(existsSync(join(dir, 'out', 'src', 'big.bin'))).toBe(true)
  })
})

// The bundled FULL 7-Zip is the .rar fallback. We can't synthesize a .rar (no encoder),
// but we can prove the shipped binary actually carries the Rar/Rar5 decoder.
const full7z = bundledFull7zPath()
describe.skipIf(!full7z)('bundled full 7-Zip carries the Rar codec', () => {
  it('lists Rar/Rar5 among supported formats', () => {
    const out = spawnSync(full7z!, ['i'], { encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(out.stdout).toMatch(/Rar5?/)
  })
})
