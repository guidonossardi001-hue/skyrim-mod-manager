// Costruttore di header TES4 binari sintetici per i TEST (stesso layout di Skyrim SE:
// record header 24 byte + subrecord 4cc/size u16le/payload). Estratto da espParser.test.ts
// perché serve anche ai test del deployer (master mancanti) — importare un file .test da
// un altro test riesegue i suoi describe() ed è vietato da vitest.

function sub(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(6)
  head.write(type, 0, 'ascii')
  head.writeUInt16LE(data.length, 4)
  return Buffer.concat([head, data])
}
function zstring(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
}
function mast(name: string): Buffer {
  const data = Buffer.alloc(8) // DATA u64 (dimensione master, ignorata dal parser)
  return Buffer.concat([sub('MAST', zstring(name)), sub('DATA', data)])
}
export function buildTes4(opts: { esm?: boolean; light?: boolean; masters?: string[]; version?: number }): Buffer {
  const hedr = Buffer.alloc(12)
  hedr.writeFloatLE(opts.version ?? 1.7, 0)
  const payload = Buffer.concat([sub('HEDR', hedr), ...(opts.masters ?? []).map(mast)])
  const head = Buffer.alloc(24)
  head.write('TES4', 0, 'ascii')
  head.writeUInt32LE(payload.length, 4)
  head.writeUInt32LE((opts.esm ? 0x1 : 0) | (opts.light ? 0x200 : 0), 8)
  return Buffer.concat([head, payload])
}
