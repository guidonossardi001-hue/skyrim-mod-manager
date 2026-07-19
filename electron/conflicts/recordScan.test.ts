import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { buildPlugin, buildGrup, buildRecord, sub, zstring } from '../plugins/tes4Fixture'
import { crc32 } from '../plugins/crc32'
import { scanRecordsForConflicts, extractEdid, type ScannedRecord } from './recordScan'

const FLAG_COMPRESSED = 0x0004_0000
const M = { masters: ['Skyrim.esm'] }

function collect(buf: Buffer) {
  const records: ScannedRecord[] = []
  const result = scanRecordsForConflicts(buf, (r) => {
    records.push(r)
  })
  return { records, result }
}

/** Payload compresso di formato reale: u32le dimensione decompressa + stream zlib. */
function compress(payload: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(payload.length, 0)
  return Buffer.concat([head, deflateSync(payload)])
}

describe('scanRecordsForConflicts', () => {
  it('emette signature/formId/flags/crc per ogni record, TES4 escluso', () => {
    const data = Buffer.from('payload-weap')
    const buf = buildPlugin(M, [buildGrup('WEAP', [buildRecord('WEAP', 0x01_000001, 0, { data })])])
    const { records, result } = collect(buf)
    expect(result.parsed).toBe(true)
    expect(result.header?.masters).toEqual(['Skyrim.esm'])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      signature: 'WEAP',
      formId: 0x01_000001,
      dataCrc: crc32(data),
      compressedBad: false,
    })
  })

  it('estrae EDID dal payload e cammina GRUP annidati', () => {
    const payload = Buffer.concat([sub('EDID', zstring('IronSword')), sub('DATA', Buffer.alloc(4))])
    const inner = buildGrup('CELL', [buildRecord('REFR', 0x00_000009)])
    const buf = buildPlugin(M, [
      buildGrup('WRLD', [buildRecord('WEAP', 0x00_000001, 0, { data: payload }), inner]),
    ])
    const { records, result } = collect(buf)
    expect(result.parsed).toBe(true)
    expect(records.map((r) => r.signature)).toEqual(['WEAP', 'REFR'])
    expect(records[0].edid).toBe('IronSword')
    expect(records[1].edid).toBeNull()
  })

  it('record compresso: crc calcolato sul payload DECOMPRESSO (uguale al gemello non compresso)', () => {
    const payload = Buffer.concat([sub('EDID', zstring('Compressed')), Buffer.alloc(64, 0x42)])
    const plain = buildRecord('NPC_', 0x00_000002, 0, { data: payload })
    const packed = buildRecord('NPC_', 0x00_000002, 0, { data: compress(payload), flags: FLAG_COMPRESSED })
    const { records: a } = collect(buildPlugin(M, [buildGrup('NPC_', [plain])]))
    const { records: b } = collect(buildPlugin(M, [buildGrup('NPC_', [packed])]))
    expect(b[0].compressedBad).toBe(false)
    expect(b[0].dataCrc).toBe(a[0].dataCrc)
    expect(b[0].edid).toBe('Compressed')
  })

  it('stream compresso corrotto: compressedBad, crc di fallback sul payload raw', () => {
    const raw = Buffer.concat([Buffer.from([32, 0, 0, 0]), Buffer.from('not-zlib-data')])
    const rec = buildRecord('NPC_', 0x00_000003, 0, { data: raw, flags: FLAG_COMPRESSED })
    const { records, result } = collect(buildPlugin(M, [buildGrup('NPC_', [rec])]))
    expect(result.parsed).toBe(true)
    expect(result.compressedBadCount).toBe(1)
    expect(records[0].compressedBad).toBe(true)
    expect(records[0].dataCrc).toBe(crc32(raw))
  })

  it('dimensione dichiarata incoerente con lo stream: compressedBad', () => {
    const payload = Buffer.alloc(16, 0x11)
    const lying = Buffer.concat([Buffer.from([99, 0, 0, 0]), deflateSync(payload)]) // dichiara 99, sono 16
    const rec = buildRecord('ARMO', 0x00_000004, 0, { data: lying, flags: FLAG_COMPRESSED })
    const { records } = collect(buildPlugin(M, [buildGrup('ARMO', [rec])]))
    expect(records[0].compressedBad).toBe(true)
  })

  it('coda spazzatura → parsed false (il chiamante deve scartare i record emessi)', () => {
    const good = buildPlugin(M, [buildGrup('WEAP', [buildRecord('WEAP', 0x00_000001)])])
    const { result } = collect(Buffer.concat([good, Buffer.from('junk')]))
    expect(result.parsed).toBe(false)
  })

  it('buffer non-plugin → parsed false, header null, zero record', () => {
    const { records, result } = collect(Buffer.from('this is not a TES4 plugin at all'))
    expect(result.parsed).toBe(false)
    expect(result.header).toBeNull()
    expect(records).toHaveLength(0)
  })
})

describe('extractEdid', () => {
  it('gestisce il subrecord esteso XXXX prima di EDID', () => {
    // XXXX (size 4, payload u32=10) dichiara la size reale del subrecord successivo,
    // il cui size u16 è 0: ONAM header "vuoto" seguito da 10 byte di payload raw.
    const big = Buffer.alloc(10, 0x55)
    const data = Buffer.concat([
      sub('XXXX', Buffer.from([10, 0, 0, 0])),
      sub('ONAM', Buffer.alloc(0)),
      big,
      sub('EDID', zstring('AfterXXXX')),
    ])
    expect(extractEdid(data)).toBe('AfterXXXX')
  })

  it('payload malformato → null, mai throw', () => {
    expect(extractEdid(Buffer.from([1, 2, 3]))).toBeNull()
    const truncated = sub('EDID', zstring('Cut')).subarray(0, 7)
    expect(extractEdid(truncated)).toBeNull()
  })
})
