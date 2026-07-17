// Lettura della FileVersion dal PE (VS_FIXEDFILEINFO) — la VERITÀ sul runtime.
//
// Perché esiste: readSkyrimVersion stimava la versione del gioco dal NOME dei bin di
// Address Library in Data/SKSE/Plugins, prendendo il PIÙ ALTO. Regge finché lì c'è solo
// il bin del runtime corrente; il deploy della collection porta l'Address Library
// ALL-IN-ONE (bin per OGNI runtime 1.5.x/1.6.x) e l'euristica salta al massimo
// disponibile — caso reale: exe 1.6.1170 su disco, stima "1.6.1179" → falso drift
// "Steam ha aggiornato il gioco" + falso "SKSE non supporta questa versione" con
// AVVIO BLOCCATO a gioco perfettamente coerente.
//
// Parse minimale e difensivo, PURO sulla Buffer (fs iniettabile nei test):
//   DOS 'MZ' → e_lfanew → 'PE\0\0' → section headers → sezione .rsrc → scan della
//   firma VS_FIXEDFILEINFO (0xFEEF04BD + dwStrucVersion 0x00010000) → dwFileVersion.
// Si legge SOLO header + sezione .rsrc (pochi KB/MB), mai l'exe intero; il risultato
// è cached per path+size+mtime (detectSteamEnv gira a ogni preflight).

import { openSync, readSync, closeSync, statSync } from 'fs'

const FIXEDFILEINFO_SIGNATURE = 0xfeef04bd
const FIXEDFILEINFO_STRUCVERSION = 0x00010000

/** Estrae la FileVersion "a.b.c.d" dal contenuto della sezione risorse. */
export function findFixedFileVersion(rsrc: Buffer): string | null {
  // La firma è allineata a 4 dentro VS_VERSIONINFO; si scansiona comunque byte-per-byte
  // (padding variabile) e si valida con dwStrucVersion per escludere collisioni.
  for (let i = 0; i + 16 <= rsrc.length; i++) {
    if (rsrc.readUInt32LE(i) !== FIXEDFILEINFO_SIGNATURE) continue
    if (rsrc.readUInt32LE(i + 4) !== FIXEDFILEINFO_STRUCVERSION) continue
    const ms = rsrc.readUInt32LE(i + 8)
    const ls = rsrc.readUInt32LE(i + 12)
    return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
  }
  return null
}

/** Header di sezione PE: nome + range raw nel file. */
export function parseSectionHeaders(
  header: Buffer,
): { name: string; rawPtr: number; rawSize: number }[] | null {
  if (header.length < 0x40 || header.toString('ascii', 0, 2) !== 'MZ') return null
  const peOff = header.readUInt32LE(0x3c)
  if (peOff + 24 > header.length) return null
  if (header.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') return null
  const numSections = header.readUInt16LE(peOff + 6)
  const optSize = header.readUInt16LE(peOff + 20)
  const sectionsOff = peOff + 24 + optSize
  const out: { name: string; rawPtr: number; rawSize: number }[] = []
  for (let s = 0; s < numSections; s++) {
    const off = sectionsOff + s * 40
    if (off + 40 > header.length) return null
    let end = off
    while (end < off + 8 && header[end] !== 0) end++
    out.push({
      name: header.toString('ascii', off, end),
      rawSize: header.readUInt32LE(off + 16),
      rawPtr: header.readUInt32LE(off + 20),
    })
  }
  return out
}

// Cache per path: l'exe del gioco non cambia tra un preflight e l'altro.
const cache = new Map<string, { size: number; mtimeMs: number; version: string | null }>()

/** FileVersion di un exe/dll ("1.6.1170.0"), null se illeggibile. Mai throw. */
export function readPeFileVersion(filePath: string): string | null {
  try {
    const st = statSync(filePath)
    const hit = cache.get(filePath)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.version
    let version: string | null = null
    const fd = openSync(filePath, 'r')
    try {
      // Header DOS+PE+sezioni: 8 KB coprono qualsiasi layout reale.
      const head = Buffer.alloc(8192)
      const got = readSync(fd, head, 0, head.length, 0)
      const sections = parseSectionHeaders(head.subarray(0, got))
      const rsrc = sections?.find((s) => s.name === '.rsrc')
      if (rsrc && rsrc.rawSize > 0 && rsrc.rawSize < 64 * 1024 * 1024) {
        const buf = Buffer.alloc(rsrc.rawSize)
        const n = readSync(fd, buf, 0, rsrc.rawSize, rsrc.rawPtr)
        version = findFixedFileVersion(buf.subarray(0, n))
      }
    } finally {
      closeSync(fd)
    }
    cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, version })
    return version
  } catch {
    return null
  }
}
