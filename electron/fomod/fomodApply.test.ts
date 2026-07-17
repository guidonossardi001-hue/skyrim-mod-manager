import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hasFomod } from './fomodApply'

const roots: string[] = []
function tmpMod(structure: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'smm-fomod-'))
  roots.push(root)
  for (const rel of structure) {
    const abs = join(root, rel)
    if (rel.endsWith('/')) mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, 'x')
    }
  }
  return root
}
afterAll(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('hasFomod — root e wrapper annidati', () => {
  it('config alla radice → true (comportamento storico)', () => {
    expect(hasFomod(tmpMod(['fomod/ModuleConfig.xml']))).toBe(true)
  })

  it('case-insensitive su cartella e file', () => {
    expect(hasFomod(tmpMod(['FOMOD/moduleconfig.XML']))).toBe(true)
  })

  it('config dentro UN wrapper → true (caso reale: 137/1939 mod della collection)', () => {
    expect(hasFomod(tmpMod(['Reverb Overhaul/fomod/ModuleConfig.xml', 'Reverb Overhaul/00 Main Files/a.esp']))).toBe(
      true,
    )
  })

  it('config dentro DUE wrapper → true', () => {
    expect(hasFomod(tmpMod(['outer/inner/fomod/ModuleConfig.xml']))).toBe(true)
  })

  it('tre livelli di wrapper → fuori dal raggio di ricerca (bounded): false', () => {
    expect(hasFomod(tmpMod(['a/b/c/fomod/ModuleConfig.xml']))).toBe(false)
  })

  it('nessuna config → false; cartella fomod senza ModuleConfig → false', () => {
    expect(hasFomod(tmpMod(['textures/a.dds']))).toBe(false)
    expect(hasFomod(tmpMod(['fomod/info.xml']))).toBe(false)
  })

  it('directory inesistente → false, mai throw', () => {
    expect(hasFomod('Z:/non/esiste')).toBe(false)
  })
})
