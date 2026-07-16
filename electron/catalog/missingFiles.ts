// Pianificazione dei file di collection MANCANTI in locale. Il caso reale: 156 mod della
// collection hanno più file required (main + patch ESL/USSEP, main + addon) e gli import
// storici — catalogo con UNIQUE(nexus_id) — ne avevano tenuto UNO per mod. Dopo la migrazione
// 11 il catalogo contiene una riga per file: qui si decide quali coppie (nexus_id, file_id)
// vanno ancora scaricate, senza MAI toccare il lavoro già fatto (download completati e
// cartelle estratte vengono saltati, non rifatti). Puro e iniettabile → unit-testabile.

import { sanitizePathSegment } from '../util/paths'

export interface CollectionCatalogRow {
  nexus_id: number | null
  nexus_file_id: number | null
  name: string
  size_mb: number | null
  required: number | null
}

export interface ExistingDownload {
  nexus_id: number | null
  file_id: number | null
  status: string
}

export interface MissingFilePlanEntry {
  nexusId: number
  fileId: number
  name: string
  sizeBytes: number
  required: boolean
}

/** Stato di una riga downloads che conta come "già in lavorazione": non va ri-accodata.
 *  'failed' è escluso di proposito — un fallito va ritentato dal piano. */
const BUSY_STATUSES = new Set(['pending', 'queued', 'downloading', 'paused', 'installing', 'completed'])

/** Cartella di estrazione attesa per una riga (stesso schema di installManager/massSync:
 *  `<nexus_id>-<nome sanificato>`). */
export function expectedModDirName(nexusId: number, name: string): string {
  return sanitizePathSegment(`${nexusId}-${name}`)
}

/**
 * Piano dei file da accodare: righe di catalogo con coppia (nexus_id, nexus_file_id) valida
 * per cui NON esiste né un download attivo/completato della stessa coppia né la cartella
 * mod estratta. Dedup interna sulla coppia (i re-import non producono doppioni in coda).
 */
export function planMissingFiles(
  catalogRows: CollectionCatalogRow[],
  existingDownloads: ExistingDownload[],
  dirExists: (dirName: string) => boolean,
): MissingFilePlanEntry[] {
  const busy = new Set<string>()
  for (const d of existingDownloads) {
    if (d.nexus_id && d.file_id && BUSY_STATUSES.has(d.status)) busy.add(`${d.nexus_id}:${d.file_id}`)
  }
  const seen = new Set<string>()
  const plan: MissingFilePlanEntry[] = []
  for (const r of catalogRows) {
    const nexusId = r.nexus_id
    const fileId = r.nexus_file_id
    if (!nexusId || !fileId || nexusId <= 0 || fileId <= 0) continue
    if (!r.name?.trim()) continue
    const pair = `${nexusId}:${fileId}`
    if (seen.has(pair) || busy.has(pair)) continue
    seen.add(pair)
    if (dirExists(expectedModDirName(nexusId, r.name))) continue
    plan.push({
      nexusId,
      fileId,
      name: r.name,
      sizeBytes: Math.max(0, Math.round((r.size_mb ?? 0) * 1024 * 1024)),
      required: r.required !== 0,
    })
  }
  return plan
}
