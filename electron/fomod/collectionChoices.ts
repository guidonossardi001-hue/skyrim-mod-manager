// Scelte FOMOD del curatore della collection. NON stanno nel GraphQL: vivono nel
// collection.json DENTRO l'archivio della revision (lo stesso che Vortex scarica).
// Flusso: graph collectionRevision → downloadLink → download archivio → estrazione →
// parse → cache locale (userData/collection-choices.json). Parse difensivo ovunque.
//
// Shape reale (Vortex extension-collections, transformCollection.ts):
//   mods[]: { name, version, optional, source: { type:'nexus', modId, fileId },
//             choices?: { type:'fomod', options: [ { name, groups: [ { name,
//             choices: [ { name, idx } ] } ] } ] }, instructions?, phase?, ... }

export interface CollectionModChoices {
  modId: number | null
  fileId: number | null
  name: string
  choices: unknown[] | null // choices.options — il preset per il motore FOMOD
  instructions: string | null // note post-install del curatore (da mostrare)
}

export interface ParsedCollectionManifest {
  collectionName: string | null
  mods: CollectionModChoices[]
}

export function parseCollectionManifest(raw: string): ParsedCollectionManifest | null {
  try {
    const doc = JSON.parse(raw) as {
      info?: { name?: unknown }
      mods?: unknown[]
    }
    if (!Array.isArray(doc?.mods)) return null
    const mods: CollectionModChoices[] = []
    for (const m of doc.mods) {
      const e = m as {
        name?: unknown
        source?: { modId?: unknown; fileId?: unknown }
        choices?: { type?: unknown; options?: unknown }
        instructions?: unknown
      }
      const modId = Number(e?.source?.modId)
      const fileId = Number(e?.source?.fileId)
      const options = e?.choices && e.choices.type === 'fomod' && Array.isArray(e.choices.options) ? e.choices.options : null
      mods.push({
        modId: Number.isInteger(modId) && modId > 0 ? modId : null,
        fileId: Number.isInteger(fileId) && fileId > 0 ? fileId : null,
        name: typeof e?.name === 'string' ? e.name : '',
        choices: options,
        instructions: typeof e?.instructions === 'string' && e.instructions.trim() ? e.instructions.trim() : null,
      })
    }
    return {
      collectionName: typeof doc.info?.name === 'string' ? doc.info.name : null,
      mods,
    }
  } catch {
    return null
  }
}

/** Indice per lookup rapido: fileId → choices (chiave primaria: le scelte sono per-file),
 *  con fallback modId (versione aggiornata dello stesso mod: match più debole, loggare). */
export function indexChoices(manifest: ParsedCollectionManifest): {
  byFileId: Map<number, CollectionModChoices>
  byModId: Map<number, CollectionModChoices>
} {
  const byFileId = new Map<number, CollectionModChoices>()
  const byModId = new Map<number, CollectionModChoices>()
  for (const m of manifest.mods) {
    if (m.fileId != null && !byFileId.has(m.fileId)) byFileId.set(m.fileId, m)
    if (m.modId != null && !byModId.has(m.modId)) byModId.set(m.modId, m)
  }
  return { byFileId, byModId }
}
