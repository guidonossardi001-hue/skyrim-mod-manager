// Costruttore di header TES4 binari sintetici per i TEST (stesso layout di Skyrim SE:
// record header 24 byte + subrecord 4cc/size u16le/payload). Estratto da espParser.test.ts
// perché serve anche ai test del deployer (master mancanti) — importare un file .test da
// un altro test riesegue i suoi describe() ed è vietato da vitest.

export function sub(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(6)
  head.write(type, 0, 'ascii')
  head.writeUInt16LE(data.length, 4)
  return Buffer.concat([head, data])
}
export function zstring(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
}
function mast(name: string): Buffer {
  const data = Buffer.alloc(8) // DATA u64 (dimensione master, ignorata dal parser)
  return Buffer.concat([sub('MAST', zstring(name)), sub('DATA', data)])
}
export function buildTes4(opts: {
  esm?: boolean
  light?: boolean
  masters?: string[]
  version?: number
}): Buffer {
  const hedr = Buffer.alloc(12)
  hedr.writeFloatLE(opts.version ?? 1.7, 0)
  const payload = Buffer.concat([sub('HEDR', hedr), ...(opts.masters ?? []).map(mast)])
  const head = Buffer.alloc(24)
  head.write('TES4', 0, 'ascii')
  head.writeUInt32LE(payload.length, 4)
  head.writeUInt32LE((opts.esm ? 0x1 : 0) | (opts.light ? 0x200 : 0), 8)
  return Buffer.concat([head, payload])
}

/** Record generico post-TES4 (header 24 byte + payload opaco, o `opts.data` esplicito). */
export function buildRecord(
  type: string,
  formId: number,
  dataSize = 8,
  opts: { flags?: number; data?: Buffer } = {},
): Buffer {
  const data = opts.data ?? Buffer.alloc(dataSize, 0xab)
  const head = Buffer.alloc(24)
  head.write(type, 0, 'ascii')
  head.writeUInt32LE(data.length, 4)
  head.writeUInt32LE((opts.flags ?? 0) >>> 0, 8)
  head.writeUInt32LE(formId >>> 0, 12)
  return Buffer.concat([head, data])
}

/** GRUP: header 24 byte con groupSize che INCLUDE l'header; contenuto sequenziale. */
export function buildGrup(label: string, contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents)
  const head = Buffer.alloc(24)
  head.write('GRUP', 0, 'ascii')
  head.writeUInt32LE(24 + body.length, 4)
  head.write(label.padEnd(4).slice(0, 4), 8, 'ascii')
  return Buffer.concat([head, body])
}

/** Plugin completo: TES4 + GRUP/record. `masterIdx` alto nel formId = spazio proprio. */
export function buildPlugin(tes4: Parameters<typeof buildTes4>[0], groups: Buffer[]): Buffer {
  return Buffer.concat([buildTes4(tes4), ...groups])
}
