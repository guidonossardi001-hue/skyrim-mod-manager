// Costruttore di un PE/COFF x64 sintetico MINIMO con Export Directory Table, per i test di
// skseDllPreflight.ts. Un solo section ".rdata" con VirtualAddress == PointerToRawData (RVA
// == offset file per questa sezione: semplifica la fixture, resta un PE valido — la relazione
// RVA/offset-file di una sezione è libera, non deve differire).

export interface FakeExport {
  name: string
  /** Buffer puntato dall'export (es. la struct PluginVersionData). Assente = punta a un placeholder inerte. */
  data?: Buffer
}

export interface FakeDllOptions {
  machine?: number // default 0x8664 (AMD64)
  exports: FakeExport[]
  /** Se true, il campo VirtualAddress della Export Directory è 0 (nessuna export table). */
  noExportTable?: boolean
}

const DOS_HEADER_SIZE = 0x40
const E_LFANEW = 0x80
const FILE_HEADER_SIZE = 20
const OPTIONAL_MAGIC_PE32PLUS = 0x20b
const DATA_DIR_OFFSET_PE32PLUS = 112
const NUM_DATA_DIRS = 16
const OPTIONAL_HEADER_SIZE = DATA_DIR_OFFSET_PE32PLUS + NUM_DATA_DIRS * 8 // 240
const SECTION_HEADER_SIZE = 40
const SECTION_DATA_RVA = 0x1000 // arbitrario, > fine section table

/** Costruisce un buffer PE completo: header+optional+1 sezione con export directory. */
export function buildFakeSkseDll(opts: FakeDllOptions): Buffer {
  const machine = opts.machine ?? 0x8664
  const n = opts.exports.length

  // ── Layout della sezione dati, tutto calcolato in sequenza (nessun offset a mano) ──
  const exportDirOff = 0
  const exportDirSize = 40
  const funcsOff = exportDirOff + exportDirSize
  const namesOff = funcsOff + n * 4
  const ordsOff = namesOff + n * 4
  let cursor = ordsOff + n * 2

  const dllNameOff = cursor
  cursor += 'test.dll\0'.length

  const nameOffsets: number[] = []
  for (const exp of opts.exports) {
    nameOffsets.push(cursor)
    cursor += exp.name.length + 1
  }
  // Placeholder inerte per export senza blob dati proprio (es. una funzione: il contenuto
  // non viene mai letto dal classificatore, basta che il puntatore sia valido).
  const placeholderOff = cursor
  cursor += 4
  const blobOffsets: number[] = []
  for (const exp of opts.exports) {
    if (exp.data) {
      blobOffsets.push(cursor)
      cursor += exp.data.length
    } else {
      blobOffsets.push(placeholderOff)
    }
  }

  const sectionDataSize = cursor
  const sectionData = Buffer.alloc(sectionDataSize)

  sectionData.writeUInt32LE(0, exportDirOff + 0) // Characteristics
  sectionData.writeUInt32LE(0, exportDirOff + 4) // TimeDateStamp
  sectionData.writeUInt16LE(0, exportDirOff + 8) // MajorVersion
  sectionData.writeUInt16LE(0, exportDirOff + 10) // MinorVersion
  sectionData.writeUInt32LE(SECTION_DATA_RVA + dllNameOff, exportDirOff + 12) // Name RVA
  sectionData.writeUInt32LE(1, exportDirOff + 16) // Base
  sectionData.writeUInt32LE(n, exportDirOff + 20) // NumberOfFunctions
  sectionData.writeUInt32LE(n, exportDirOff + 24) // NumberOfNames
  sectionData.writeUInt32LE(SECTION_DATA_RVA + funcsOff, exportDirOff + 28) // AddressOfFunctions
  sectionData.writeUInt32LE(SECTION_DATA_RVA + namesOff, exportDirOff + 32) // AddressOfNames
  sectionData.writeUInt32LE(SECTION_DATA_RVA + ordsOff, exportDirOff + 36) // AddressOfNameOrdinals

  opts.exports.forEach((exp, i) => {
    sectionData.writeUInt32LE(SECTION_DATA_RVA + blobOffsets[i], funcsOff + i * 4)
    sectionData.writeUInt32LE(SECTION_DATA_RVA + nameOffsets[i], namesOff + i * 4)
    sectionData.writeUInt16LE(i, ordsOff + i * 2) // ordinale = indice diretto in AddressOfFunctions
    sectionData.write(exp.name, nameOffsets[i], 'ascii')
    sectionData[nameOffsets[i] + exp.name.length] = 0
    if (exp.data) exp.data.copy(sectionData, blobOffsets[i])
  })
  sectionData.write('test.dll', dllNameOff, 'ascii')
  sectionData[dllNameOff + 8] = 0

  // ── Header PE completo ────────────────────────────────────────────────────────
  const dos = Buffer.alloc(DOS_HEADER_SIZE)
  dos.write('MZ', 0, 'ascii')
  dos.writeUInt32LE(E_LFANEW, 0x3c)

  const fileHeader = Buffer.alloc(FILE_HEADER_SIZE)
  fileHeader.writeUInt16LE(machine, 0)
  fileHeader.writeUInt16LE(1, 2) // NumberOfSections
  fileHeader.writeUInt16LE(OPTIONAL_HEADER_SIZE, 16) // SizeOfOptionalHeader

  const optHeader = Buffer.alloc(OPTIONAL_HEADER_SIZE)
  optHeader.writeUInt16LE(OPTIONAL_MAGIC_PE32PLUS, 0)
  if (!opts.noExportTable) {
    optHeader.writeUInt32LE(SECTION_DATA_RVA, DATA_DIR_OFFSET_PE32PLUS) // DataDirectory[0].VirtualAddress
    optHeader.writeUInt32LE(exportDirSize, DATA_DIR_OFFSET_PE32PLUS + 4) // DataDirectory[0].Size
  }

  const sectionTableOff = E_LFANEW + 4 + FILE_HEADER_SIZE + OPTIONAL_HEADER_SIZE
  const sectionDataFileOff = sectionTableOff + SECTION_HEADER_SIZE // subito dopo la section table
  const sectionHeader = Buffer.alloc(SECTION_HEADER_SIZE)
  sectionHeader.write('.rdata', 0, 'ascii')
  sectionHeader.writeUInt32LE(sectionDataSize, 8) // VirtualSize
  sectionHeader.writeUInt32LE(SECTION_DATA_RVA, 12) // VirtualAddress
  sectionHeader.writeUInt32LE(sectionDataSize, 16) // SizeOfRawData
  sectionHeader.writeUInt32LE(sectionDataFileOff, 20) // PointerToRawData

  const head = Buffer.alloc(E_LFANEW)
  dos.copy(head)
  return Buffer.concat([head, Buffer.from('PE\0\0', 'ascii'), fileHeader, optHeader, sectionHeader, sectionData])
}

/** Costruisce la struct PluginVersionData (0x350 byte) coi campi indicati. */
export function buildPluginVersionData(opts: {
  dataVersion?: number
  pluginVersion?: number
  name?: string
  author?: string
  addressLibrary?: boolean
  signatureScanning?: boolean
  structsPost629?: boolean
  noStructUse?: boolean
  compatibleVersions?: number[]
  xseMinimum?: number
}): Buffer {
  const buf = Buffer.alloc(0x350)
  buf.writeUInt32LE(opts.dataVersion ?? 1, 0x000)
  buf.writeUInt32LE(opts.pluginVersion ?? 0, 0x004)
  if (opts.name) buf.write(opts.name, 0x008, 'ascii')
  if (opts.author) buf.write(opts.author, 0x108, 'ascii')
  buf.writeUInt32LE(opts.noStructUse ? 1 : 0, 0x304)
  const flags =
    (opts.addressLibrary ? 1 << 0 : 0) | (opts.signatureScanning ? 1 << 1 : 0) | (opts.structsPost629 ? 1 << 2 : 0)
  buf.writeUInt32LE(flags, 0x308)
  ;(opts.compatibleVersions ?? []).forEach((v, i) => buf.writeUInt32LE(v, 0x30c + i * 4))
  buf.writeUInt32LE(opts.xseMinimum ?? 0, 0x34c)
  return buf
}

export function packVersion(major: number, minor: number, patch: number, build: number): number {
  return ((major & 0xff) << 24) | ((minor & 0xff) << 16) | ((patch & 0xfff) << 4) | (build & 0xf)
}
