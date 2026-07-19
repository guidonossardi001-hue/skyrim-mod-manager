import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { deflateSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlugin, buildGrup, buildRecord, sub, zstring } from '../plugins/tes4Fixture'
import { parseSubrecords, snapshotRecord, buildDiffRows, type RecordSnapshot } from './recordDiff'

const FLAG_COMPRESSED = 0x0004_0000
const M = { masters: ['Base.esm'] }
const noLight = () => false

describe('parseSubrecords', () => {
  it('sequenza con occorrenze ripetute e XXXX esteso', () => {
    const big = Buffer.alloc(10, 0x55)
    const payload = Buffer.concat([
      sub('EDID', zstring('Sword')),
      sub('CTDA', Buffer.alloc(8, 1)),
      sub('CTDA', Buffer.alloc(8, 2)),
      sub('XXXX', Buffer.from([10, 0, 0, 0])),
      sub('ONAM', Buffer.alloc(0)),
      big,
    ])
    const cells = parseSubrecords(payload)
    expect(cells.map((c) => `${c.type}#${c.occurrence}`)).toEqual(['EDID#1', 'CTDA#1', 'CTDA#2', 'ONAM#1'])
    expect(cells[1].crc).not.toBe(cells[2].crc) // payload CTDA diversi
    expect(cells[3].size).toBe(10) // size dal prefisso XXXX
  })

  it('payload malformato: stop silenzioso, mai throw', () => {
    expect(parseSubrecords(Buffer.from([1, 2, 3]))).toEqual([])
    const truncated = sub('EDID', zstring('Cut')).subarray(0, 7)
    expect(parseSubrecords(truncated)).toEqual([])
  })
})

describe('snapshotRecord', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smm-rdiff-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, buf: Buffer) => {
    const path = join(dir, name)
    writeFileSync(path, buf)
    return { plugin: name.toLowerCase(), displayName: name, path }
  }

  it('trova il record via formKey e ne estrae i subrecord', () => {
    const payload = Buffer.concat([sub('EDID', zstring('IronSword')), sub('DATA', Buffer.alloc(4, 9))])
    const t = write(
      'ModA.esp',
      buildPlugin(M, [
        buildGrup('WEAP', [
          buildRecord('WEAP', 0x00_000005, 0, { data: Buffer.alloc(8, 1) }),
          buildRecord('WEAP', 0x00_000001, 0, { data: payload }),
        ]),
      ]),
    )
    const s = snapshotRecord(t, 'base.esm|000001', noLight)
    expect(s.found).toBe(true)
    expect(s.signature).toBe('WEAP')
    expect(s.edid).toBe('IronSword')
    expect(s.subrecords.map((c) => c.type)).toEqual(['EDID', 'DATA'])
  })

  it('record compresso: subrecord estratti dal payload decompresso', () => {
    const payload = Buffer.concat([sub('EDID', zstring('Packed')), sub('DNAM', Buffer.alloc(6, 3))])
    const head = Buffer.alloc(4)
    head.writeUInt32LE(payload.length, 0)
    const t = write(
      'ModC.esp',
      buildPlugin(M, [
        buildGrup('NPC_', [
          buildRecord('NPC_', 0x00_000002, 0, {
            data: Buffer.concat([head, deflateSync(payload)]),
            flags: FLAG_COMPRESSED,
          }),
        ]),
      ]),
    )
    const s = snapshotRecord(t, 'base.esm|000002', noLight)
    expect(s.found).toBe(true)
    expect(s.compressedBad).toBe(false)
    expect(s.subrecords.map((c) => c.type)).toEqual(['EDID', 'DNAM'])
  })

  it('record assente / file illeggibile → found false, mai throw', () => {
    const t = write('ModB.esp', buildPlugin(M, [buildGrup('WEAP', [buildRecord('WEAP', 0x00_000007)])]))
    expect(snapshotRecord(t, 'base.esm|000001', noLight).found).toBe(false)
    expect(
      snapshotRecord({ plugin: 'x', displayName: 'X.esp', path: join(dir, 'missing.esp') }, 'k|1', noLight)
        .found,
    ).toBe(false)
  })
})

describe('buildDiffRows', () => {
  const snap = (plugin: string, cells: { type: string; crc: number }[], found = true): RecordSnapshot => ({
    plugin,
    displayName: plugin,
    found,
    compressedBad: false,
    signature: 'WEAP',
    edid: null,
    subrecords: cells.map((c, i) => ({
      type: c.type,
      occurrence: cells.slice(0, i + 1).filter((x) => x.type === c.type).length,
      size: 4,
      crc: c.crc,
      previewHex: 'aa',
    })),
  })

  it('differs per CRC diverso o subrecord mancante; ordine dal vincitore', () => {
    const rows = buildDiffRows([
      snap('base.esm', [
        { type: 'EDID', crc: 1 },
        { type: 'DATA', crc: 10 },
      ]),
      snap('moda.esp', [
        { type: 'EDID', crc: 1 },
        { type: 'DATA', crc: 20 },
      ]),
      snap('modb.esp', [
        { type: 'DATA', crc: 30 },
        { type: 'EDID', crc: 1 },
        { type: 'DNAM', crc: 5 },
      ]),
    ])
    // Ordine = sequenza del vincitore (modb): DATA, EDID, DNAM.
    expect(rows.map((r) => r.key)).toEqual(['DATA', 'EDID', 'DNAM'])
    expect(rows.find((r) => r.key === 'EDID')?.differs).toBe(false)
    expect(rows.find((r) => r.key === 'DATA')?.differs).toBe(true)
    const dnam = rows.find((r) => r.key === 'DNAM')!
    expect(dnam.differs).toBe(true) // manca in base/moda
    expect(dnam.cells[0]).toBeNull()
    expect(dnam.cells[2]?.crc).toBe(5)
  })

  it('partecipante non trovato: celle null senza marcare differs per la sola assenza del file', () => {
    const rows = buildDiffRows([
      snap('ghost.esp', [], false),
      snap('moda.esp', [{ type: 'EDID', crc: 1 }]),
      snap('modb.esp', [{ type: 'EDID', crc: 1 }]),
    ])
    const edid = rows.find((r) => r.key === 'EDID')!
    expect(edid.cells[0]).toBeNull()
    expect(edid.differs).toBe(false) // found=false non conta come divergenza
  })
})
