import { describe, it, expect } from 'vitest'
import { validateEspBuffers } from './espValidate'
import { parsePluginHeader } from './espParser'
import { scanPluginRecords } from './eslify'
import { buildPlugin, buildGrup, buildRecord } from './tes4Fixture'

const M0 = { masters: [] as string[] } // zero master: ogni record è "proprio" (index 0 >= masterCount 0)

function validate(name: string, tes4: Parameters<typeof buildPlugin>[0], groups: Buffer[]) {
  const buf = buildPlugin(tes4, groups)
  const header = parsePluginHeader(buf)
  const scan = scanPluginRecords(buf)
  return validateEspBuffers(name, header, scan)
}

describe('validateEspBuffers — plugin full (non-light)', () => {
  it('nessun vincolo di range, sempre ok', () => {
    const r = validate('Patch.esp', M0, [buildGrup('WEAP', [buildRecord('WEAP', 0xfff)])])
    expect(r.verdict).toBe('ok')
    expect(r.isLight).toBe(false)
  })
})

describe('validateEspBuffers — plugin light, HEDR < 1.71', () => {
  const light = { ...M0, light: true, version: 1.7 }

  it('object-index nel range legacy 0x800-0xFFF → ok', () => {
    const r = validate('Light.esp', light, [buildGrup('WEAP', [buildRecord('WEAP', 0x850)])])
    expect(r.verdict).toBe('ok')
    expect(r.extendedRangeEnabled).toBe(false)
  })

  it('object-index nel range esteso 0x001-0x7FF SENZA HEDR 1.71 → error', () => {
    const r = validate('Light.esp', light, [buildGrup('WEAP', [buildRecord('WEAP', 0x100)])])
    expect(r.verdict).toBe('error')
    expect(r.outOfRangeObjectIndices).toEqual([0x100])
    expect(r.reason).toMatch(/1\.71/)
  })
})

describe('validateEspBuffers — plugin light, HEDR >= 1.71', () => {
  const lightExt = { ...M0, light: true, version: 1.71 }

  it('object-index nel range esteso 0x001-0x7FF → ok (abilitato da HEDR 1.71)', () => {
    const r = validate('LightExt.esp', lightExt, [buildGrup('WEAP', [buildRecord('WEAP', 0x100)])])
    expect(r.verdict).toBe('ok')
    expect(r.extendedRangeEnabled).toBe(true)
  })

  it('object-index 0x000 resta invalido anche col range esteso', () => {
    const r = validate('LightExt.esp', lightExt, [buildGrup('WEAP', [buildRecord('WEAP', 0x000)])])
    expect(r.verdict).toBe('error')
    expect(r.outOfRangeObjectIndices).toEqual([0])
  })
})

describe('validateEspBuffers — formVersionCounts informativo', () => {
  it('conta i formVersion senza mai bloccare', () => {
    const r = validate('Mixed.esp', M0, [buildGrup('WEAP', [buildRecord('WEAP', 0x1), buildRecord('WEAP', 0x2)])])
    expect(r.verdict).toBe('ok')
    // buildRecord del fixture non imposta formVersion (default 0) — verifichiamo solo che il
    // conteggio esista e sia coerente col numero di record, non un valore specifico bloccante.
    expect(Object.values(r.formVersionCounts).reduce((a, b) => a + b, 0)).toBe(2)
  })
})

describe('validateEspBuffers — parse anomalo', () => {
  it('scan non parsed → unknown', () => {
    const header = parsePluginHeader(Buffer.from('junk'))
    const scan = scanPluginRecords(Buffer.from('junk'))
    const r = validateEspBuffers('Broken.esp', header, scan)
    expect(r.verdict).toBe('unknown')
  })
})
