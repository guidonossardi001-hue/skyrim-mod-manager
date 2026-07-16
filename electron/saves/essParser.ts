import { inflateSync } from 'zlib'
import { decodeLz4Block } from './lz4'

// Parser dell'header dei salvataggi Skyrim SE/AE (.ess) — SOLO ciò che serve alla
// diagnosi: metadati giocatore + lista plugin (normali e light) registrata nel save.
// Layout (UESP, Skyrim Mod:Save File Format):
//   magic 'TESV_SAVEGAME' (13B) · headerSize u32 · header{version u32, saveNumber u32,
//   playerName wstring, playerLevel u32, playerLocation wstring, gameDate wstring,
//   playerRace wstring, playerSex u16, exp f32×2, filetime 8B, shotW u32, shotH u32,
//   compression u16 (version ≥ 12)} · screenshot RGBA(SE) · uncompressedLen u32 ·
//   compressedLen u32 · body{formVersion u8, [gameVersion wstring nelle build recenti],
//   pluginInfoSize u32, pluginCount u8 + wstring[], (formVersion ≥ 78) lightCount u16 + wstring[]}
//
// READ-ONLY e FAIL-SOFT: qualunque anomalia di layout → null (il chiamante tratta il
// verdetto come "non verificabile", MAI un blocco o un warning spurio). Le due varianti
// di body (con/senza stringa gameVersion) sono tentate entrambe con validazione severa:
// meglio nessuna diagnosi che una diagnosi sbagliata.

export interface EssInfo {
  saveNumber: number
  playerName: string
  playerLevel: number
  playerLocation: string
  gameDate: string
  formVersion: number
  plugins: string[]
  lightPlugins: string[]
}

class Cursor {
  constructor(
    private buf: Buffer,
    public pos = 0,
  ) {}
  u8(): number {
    if (this.pos + 1 > this.buf.length) throw new RangeError('eof')
    return this.buf.readUInt8(this.pos++)
  }
  u16(): number {
    if (this.pos + 2 > this.buf.length) throw new RangeError('eof')
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }
  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError('eof')
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  skip(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw new RangeError('eof')
    this.pos += n
  }
  /** wstring Bethesda: u16 lunghezza + byte (windows-1252; qui letti latin1, lossless sui nomi file). */
  wstring(maxLen = 1024): string {
    const len = this.u16()
    if (len > maxLen || this.pos + len > this.buf.length) throw new RangeError('bad wstring')
    const s = this.buf.toString('latin1', this.pos, this.pos + len)
    this.pos += len
    return s
  }
}

const MAGIC = 'TESV_SAVEGAME'

/** Nome plugin plausibile: estensione giusta, niente byte di controllo, lunghezza sana. */
function isPlausiblePluginName(name: string): boolean {
  if (name.length < 5 || name.length > 260) return false
  if (!/\.(esm|esp|esl)$/i.test(name)) return false
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f]/.test(name)
}

/** Legge la lista plugin dal cursore già posizionato su pluginInfoSize. */
function readPluginLists(c: Cursor, formVersion: number): { plugins: string[]; light: string[] } | null {
  const pluginInfoSize = c.u32()
  if (pluginInfoSize <= 0 || pluginInfoSize > 64 * 1024) return null
  const count = c.u8()
  if (count === 0) return null
  const plugins: string[] = []
  for (let i = 0; i < count; i++) {
    const name = c.wstring(260)
    if (!isPlausiblePluginName(name)) return null
    plugins.push(name)
  }
  const light: string[] = []
  if (formVersion >= 78) {
    const lightCount = c.u16()
    if (lightCount > 4096) return null
    for (let i = 0; i < lightCount; i++) {
      const name = c.wstring(260)
      if (!isPlausiblePluginName(name)) return null
      light.push(name)
    }
  }
  return { plugins, light }
}

/**
 * Parse completo di un .ess SE/AE. null = formato non riconosciuto/corrotto (fail-soft).
 */
export function parseEss(file: Buffer): EssInfo | null {
  try {
    if (file.length < 64) return null
    if (file.toString('latin1', 0, MAGIC.length) !== MAGIC) return null
    const c = new Cursor(file, MAGIC.length)
    const headerSize = c.u32()
    if (headerSize < 40 || headerSize > 4096) return null
    const headerStart = c.pos

    const version = c.u32()
    if (version < 7 || version > 100) return null
    const saveNumber = c.u32()
    const playerName = c.wstring(256)
    const playerLevel = c.u32()
    const playerLocation = c.wstring(512)
    const gameDate = c.wstring(256)
    c.wstring(256) // playerRaceEditorId
    c.u16() // playerSex
    c.skip(8) // exp f32×2
    c.skip(8) // filetime
    const shotW = c.u32()
    const shotH = c.u32()
    // SE (version ≥ 12): u16 compressione in coda all'header. Robustezza: fidati di
    // headerSize per riallineare comunque il cursore alla fine dell'header dichiarata.
    let compression = 0
    if (version >= 12) compression = c.u16()
    c.pos = headerStart + headerSize

    // Screenshot: SE = RGBA (4 byte/pixel), LE = RGB (3). version ≥ 12 → SE.
    const bpp = version >= 12 ? 4 : 3
    if (shotW > 4096 || shotH > 4096) return null
    c.skip(shotW * shotH * bpp)

    // Corpo: LE è inline non compresso; SE dichiara le due lunghezze.
    let body: Buffer
    if (version >= 12) {
      const uncompressedLen = c.u32()
      const compressedLen = c.u32()
      if (uncompressedLen <= 0 || uncompressedLen > 512 * 1024 * 1024) return null
      if (compressedLen <= 0 || c.pos + compressedLen > file.length) return null
      const raw = file.subarray(c.pos, c.pos + compressedLen)
      if (compression === 2) {
        // Prefix decode: formVersion + pluginInfo (≤64KB) + light list stanno tutti nei
        // primi ~256KB del corpo — decomprimere l'intero save (decine di MB) è inutile.
        const prefix = Math.min(uncompressedLen, 256 * 1024)
        const out = decodeLz4Block(raw, prefix, { partial: prefix < uncompressedLen })
        if (!out) return null
        body = out
      } else if (compression === 1) {
        body = inflateSync(raw)
      } else {
        body = raw
      }
    } else {
      body = file.subarray(c.pos)
    }

    // formVersion + lista plugin. Le build AE recenti inseriscono una wstring di
    // versione gioco tra formVersion e pluginInfo: si tenta prima il layout classico,
    // poi la variante — la validazione severa dei nomi rende il tentativo sicuro.
    const b = new Cursor(body)
    const formVersion = b.u8()
    if (formVersion < 60 || formVersion > 200) return null
    const afterForm = b.pos

    let lists: { plugins: string[]; light: string[] } | null = null
    try {
      lists = readPluginLists(new Cursor(body, afterForm), formVersion)
    } catch {
      lists = null
    }
    if (!lists) {
      try {
        const alt = new Cursor(body, afterForm)
        const gv = alt.wstring(64) // es. "1.6.1170"
        if (/^[\d.]+$/.test(gv)) lists = readPluginLists(alt, formVersion)
      } catch {
        lists = null
      }
    }
    if (!lists) return null

    return {
      saveNumber,
      playerName,
      playerLevel,
      playerLocation,
      gameDate,
      formVersion,
      plugins: lists.plugins,
      lightPlugins: lists.light,
    }
  } catch {
    return null
  }
}
