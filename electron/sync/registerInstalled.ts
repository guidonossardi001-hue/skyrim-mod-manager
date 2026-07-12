// Ponte mass-sync → tabella `mods`: registra le estrazioni dello StockGame come mod INSTALLATE
// del profilo, così il deployer (che legge mods.is_installed=1 + install_path) le vede davvero.
// Prima le due pipeline erano disconnesse: il mass-installer scriveva solo StockGame/mods/<dir> e
// il Deploy rispondeva per sempre "nessuna mod abilitata da distribuire".
//
// Idempotente per costruzione: (profile_id, nexus_id) già presente → UPDATE (solo se cambia
// qualcosa), assente → INSERT. Metadati di conflitto (deploy_category/resolution_weight) e la
// priorità ereditano dal catalogo quando la riga esiste lì — stesse convenzioni di
// installManager.markInstalled, così i due percorsi d'installazione restano coerenti.

import type { SqliteDb } from '../db/sqlite'
import { columnExists } from '../db/sqlite'

export interface InstalledCandidate {
  modId: number // nexus_id
  name: string
  installPath: string // cartella estratta (StockGame/mods/<id>-<nome>)
  fileSize?: number // peso archivio dal backup (best effort, solo per le INSERT)
}

export interface RegisterResult {
  inserted: number // nuove righe mods create
  updated: number // righe esistenti promosse a installate / ripuntate
  unchanged: number // già registrate identiche (idempotenza)
}

interface CatalogMeta {
  category: string | null
  priority_order: number | null
  deploy_category: string | null
  resolution_weight: number | null
}

export function registerInstalledMods(
  db: SqliteDb,
  profileId: number,
  candidates: InstalledCandidate[],
): RegisterResult {
  const res: RegisterResult = { inserted: 0, updated: 0, unchanged: 0 }
  if (!candidates.length) return res

  const hasMeta = columnExists(db, 'mods', 'deploy_category')
  const metaOf = (nexusId: number): CatalogMeta => {
    try {
      const cols = hasMeta
        ? 'category, priority_order, deploy_category, resolution_weight'
        : 'category, priority_order, NULL AS deploy_category, NULL AS resolution_weight'
      const m = db
        .prepare(`SELECT ${cols} FROM modlist_catalog WHERE nexus_id = ?`)
        .get(nexusId) as CatalogMeta | undefined
      return m ?? { category: null, priority_order: null, deploy_category: null, resolution_weight: null }
    } catch {
      return { category: null, priority_order: null, deploy_category: null, resolution_weight: null }
    }
  }

  // Priorità per le INSERT senza riga di catalogo: coda dopo l'attuale massimo del profilo,
  // in sequenza stabile (l'ordine dei candidati = ordine modlist del backup).
  let nextPriority =
    ((db.prepare('SELECT MAX(priority) AS m FROM mods WHERE profile_id = ?').get(profileId) as
      | { m: number | null }
      | undefined)?.m ?? 0) + 1

  const selectExisting = db.prepare(
    'SELECT id, is_installed, install_path FROM mods WHERE profile_id = ? AND nexus_id = ? ORDER BY id LIMIT 1',
  )
  const updateSql = hasMeta
    ? 'UPDATE mods SET is_installed=1, install_path=?, deploy_category=COALESCE(?, deploy_category), resolution_weight=COALESCE(?, resolution_weight), updated_at=CURRENT_TIMESTAMP WHERE id=?'
    : 'UPDATE mods SET is_installed=1, install_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  const update = db.prepare(updateSql)
  const insertSql = hasMeta
    ? `INSERT INTO mods (profile_id, nexus_id, name, category, file_size, install_path, is_enabled, is_installed, priority, deploy_category, resolution_weight)
       VALUES (?,?,?,?,?,?,1,1,?,?,?)`
    : `INSERT INTO mods (profile_id, nexus_id, name, category, file_size, install_path, is_enabled, is_installed, priority)
       VALUES (?,?,?,?,?,?,1,1,?)`
  const insert = db.prepare(insertSql)

  db.exec('BEGIN')
  try {
    for (const c of candidates) {
      if (!Number.isInteger(c.modId) || c.modId <= 0 || !c.installPath) continue
      const existing = selectExisting.get(profileId, c.modId) as
        | { id: number; is_installed: number; install_path: string | null }
        | undefined
      const meta = metaOf(c.modId)
      if (existing) {
        if (existing.is_installed === 1 && existing.install_path === c.installPath) {
          res.unchanged++
          continue
        }
        if (hasMeta) update.run(c.installPath, meta.deploy_category, meta.resolution_weight, existing.id)
        else update.run(c.installPath, existing.id)
        res.updated++
      } else {
        const priority = meta.priority_order ?? nextPriority++
        if (hasMeta)
          insert.run(
            profileId,
            c.modId,
            c.name,
            meta.category ?? 'StockGame',
            c.fileSize ?? 0,
            c.installPath,
            priority,
            meta.deploy_category,
            meta.resolution_weight,
          )
        else
          insert.run(
            profileId,
            c.modId,
            c.name,
            meta.category ?? 'StockGame',
            c.fileSize ?? 0,
            c.installPath,
            priority,
          )
        res.inserted++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return res
}
