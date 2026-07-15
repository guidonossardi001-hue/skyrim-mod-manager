import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crc32OfFile, findDirtyMatch, scanDirtyPlugins } from './dirtyPluginCheck'
import { crc32 } from './crc32'
import type { DirtyEntry } from './lootMasterlist'

describe('crc32OfFile', () => {
  it('calcola il crc32 in streaming, uguale al crc32 puro sul buffer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crc-'))
    try {
      const p = join(dir, 'Mod.esp')
      const content = Buffer.from('contenuto finto di un plugin per il test')
      writeFileSync(p, content)
      expect(await crc32OfFile(p)).toBe(crc32(content))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('null su file assente (fail-soft, mai un throw)', async () => {
    expect(await crc32OfFile('X:/non/esiste/Mod.esp')).toBeNull()
  })
})

const DIRTY: DirtyEntry[] = [
  { pluginPattern: 'USSEP.esp', crc: 0x17ab5e20, itm: 334, udr: 92, nav: 3, util: 'SSEEdit v4.0.4' },
  { pluginPattern: 'Other.esp', crc: 0xdeadbeef, itm: 1, udr: 0, nav: 0, util: 'SSEEdit' },
]

describe('findDirtyMatch', () => {
  it('trova la entry quando CRC e nome combaciano', () => {
    expect(findDirtyMatch('USSEP.esp', 0x17ab5e20, DIRTY)).toEqual({
      plugin: 'USSEP.esp',
      crc: 0x17ab5e20,
      itm: 334,
      udr: 92,
      nav: 3,
      util: 'SSEEdit v4.0.4',
    })
  })
  it('null se il CRC non combacia (versione pulita o diversa)', () => {
    expect(findDirtyMatch('USSEP.esp', 0x00000000, DIRTY)).toBeNull()
  })
  it('null se il CRC combacia ma il nome no (evita falsi positivi tra mod diverse)', () => {
    expect(findDirtyMatch('NotUSSEP.esp', 0x17ab5e20, DIRTY)).toBeNull()
  })
})

describe('scanDirtyPlugins', () => {
  it('scansiona una lista di plugin e ritorna solo quelli sporchi, saltando i file illeggibili', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'))
    try {
      const dirtyContent = Buffer.from('X')
      // Costruiamo un file il cui crc32 sia noto e lo registriamo come dirty entry.
      const knownCrc = crc32(dirtyContent)
      const dirtyPath = join(dir, 'Known.esp')
      writeFileSync(dirtyPath, dirtyContent)
      const cleanPath = join(dir, 'Clean.esp')
      writeFileSync(cleanPath, Buffer.from('contenuto diverso'))

      const entries: DirtyEntry[] = [
        { pluginPattern: 'Known.esp', crc: knownCrc, itm: 5, udr: 1, nav: 0, util: 'SSEEdit' },
      ]
      const found = await scanDirtyPlugins(
        [
          { name: 'Known.esp', path: dirtyPath },
          { name: 'Clean.esp', path: cleanPath },
          { name: 'Missing.esp', path: join(dir, 'assente.esp') },
        ],
        entries,
      )
      expect(found).toEqual([{ plugin: 'Known.esp', crc: knownCrc, itm: 5, udr: 1, nav: 0, util: 'SSEEdit' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
