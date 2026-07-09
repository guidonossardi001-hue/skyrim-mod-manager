// Genera resources/icons/icon.ico — icona segnaposto valida per electron-builder.
// Zero dipendenze: costruisce un PNG 256x256 RGBA (zlib è built-in in Node) e lo
// impacchetta in un container ICO (Windows supporta entry PNG per il formato 256px,
// ed electron-builder richiede almeno 256x256).
//
// Uso:  node scripts/make_placeholder_icon.mjs
// Sostituisci il file con l'icona definitiva quando disponibile (stesso percorso).

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256

// ── Disegno: quadrato arrotondato con gradiente viola→blu (palette dell'app),
//    rombo chiaro centrale come segnaposto del logo ────────────────────────────
function drawPixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4)
  const radius = 44
  const lerp = (a, b, t) => Math.round(a + (b - a) * t)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // arrotondamento angoli: distanza dal rettangolo interno
      const cx = Math.max(radius - x, 0, x - (SIZE - 1 - radius))
      const cy = Math.max(radius - y, 0, y - (SIZE - 1 - radius))
      const outside = Math.sqrt(cx * cx + cy * cy) > radius
      const i = (y * SIZE + x) * 4
      if (outside) {
        px[i + 3] = 0
        continue
      }
      // gradiente diagonale #7d4dff → #4d7dff
      const t = (x + y) / (2 * (SIZE - 1))
      let r = lerp(0x7d, 0x4d, t),
        g = lerp(0x4d, 0x7d, t),
        b = 0xff
      // rombo centrale semitrasparente
      const d = Math.abs(x - SIZE / 2) + Math.abs(y - SIZE / 2)
      if (d < 78) {
        const glow = d < 62 ? 0.85 : 0.85 * (1 - (d - 62) / 16)
        r = lerp(r, 0xff, glow)
        g = lerp(g, 0xff, glow)
        b = lerp(b, 0xff, glow)
      }
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = 255
    }
  }
  return px
}

// ── PNG writer minimale (IHDR + IDAT + IEND, CRC32 incluso) ──────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // 8-bit, RGBA
  // scanline: filtro 0 + riga di pixel
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
  for (let y = 0; y < SIZE; y++) {
    pixels.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Container ICO: header (6 byte) + 1 directory entry (16 byte) + PNG ───────
function encodeIco(png) {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]) // reserved, type=icon, count=1
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256 → 0
  entry[1] = 0 // height 256 → 0
  entry[4] = 1 // color planes
  entry[6] = 32 // bit depth
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12) // offset: 6 header + 16 entry
  return Buffer.concat([header, entry, png])
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'icons')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'icon.ico')
writeFileSync(out, encodeIco(encodePng(drawPixels())))
console.log(`icona segnaposto generata: ${out}`)
