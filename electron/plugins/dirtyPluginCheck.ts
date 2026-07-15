// Rilevamento plugin "sporchi" (ITM/UDR) — confronta il CRC32 del file installato contro il
// database del masterlist LOOT reale. PURO informativo: mai un blocco del deploy, solo un
// warning ("va pulito con SSEEdit") — la pulizia stessa richiede xEdit (fuori scope, per scelta:
// vedi ricerca GitHub, editing a livello record va shellato a xEdit, non reimplementato).

import { createReadStream } from 'fs'
import { crc32Update, crc32Finalize, CRC32_INIT } from './crc32'
import { matchesPluginPattern, type DirtyEntry } from './lootMasterlist'

export interface DirtyMatch {
  plugin: string
  crc: number
  itm: number
  udr: number
  nav: number
  util: string
}

/** CRC32 dell'intero file in streaming (i plugin possono pesare fino a decine di MB: mai
 * caricarli interi in memoria). Errore I/O -> null (fail-soft: il check è solo informativo). */
export function crc32OfFile(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let acc = CRC32_INIT
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      acc = crc32Update(acc, chunk as Buffer)
    })
    stream.on('end', () => resolve(crc32Finalize(acc)))
    stream.on('error', () => resolve(null))
  })
}

/** Cerca `crc` tra le entry `dirty` il cui pattern combacia col nome plugin. Nessun match -> null. */
export function findDirtyMatch(pluginName: string, crc: number, dirty: DirtyEntry[]): DirtyMatch | null {
  for (const d of dirty) {
    if (d.crc === crc && matchesPluginPattern(d.pluginPattern, pluginName)) {
      return { plugin: pluginName, crc: d.crc, itm: d.itm, udr: d.udr, nav: d.nav, util: d.util }
    }
  }
  return null
}

/** Scansiona una lista di plugin (nome + path assoluto) e ritorna quelli sporchi trovati.
 * Un file illeggibile viene semplicemente saltato (fail-soft, mai un throw). */
export async function scanDirtyPlugins(
  plugins: { name: string; path: string }[],
  dirty: DirtyEntry[],
): Promise<DirtyMatch[]> {
  const found: DirtyMatch[] = []
  for (const p of plugins) {
    const crc = await crc32OfFile(p.path)
    if (crc == null) continue
    const match = findDirtyMatch(p.name, crc, dirty)
    if (match) found.push(match)
  }
  return found
}
