// Indice SQLite dei record per la rilevazione dei conflitti logici (CONFLICTS Fase 1).
//
// Modello: una riga per (plugin, form_key) con signature + CRC del payload. Un CONFLITTO
// è una form_key con >= 2 OVERRIDE (righe is_own=0) da plugin diversi: il record di
// origine (is_own=1) partecipa al confronto ma da solo non fa conflitto — un singolo
// override del vanilla è il funzionamento normale di un mod, non un conflitto (stessa
// semantica del "benign override" verde di xEdit).
//
// Incrementale: la scansione binaria (readFileSync + walk) avviene SOLO per i plugin con
// (size, mtime) diversi dall'ultima volta; per gli altri si aggiorna soltanto order_idx.
// Con la collezione reale (~GB di plugin) il cold scan è nell'ordine dei secondi, il warm
// scan è quasi solo stat(). Tutte le query usano SOLO parametri posizionali `?` (superficie
// comune better-sqlite3 / node:sqlite, come il resto di electron/db) — mai SQL interpolato
// con input esterno.

import { statSync, readFileSync } from 'node:fs'
import { withTransaction, type SqliteDb } from '../db/sqlite'
import { readPluginHeader } from '../plugins/espParser'
import { scanRecordsForConflicts, type ScannedRecord } from './recordScan'
import { resolveFormKey, isLightSpace } from './formKey'

export function ensureConflictSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conflict_plugin_scan (
      plugin TEXT PRIMARY KEY,           -- nome file lowercase (identità case-insensitive Windows)
      display_name TEXT NOT NULL,
      path TEXT NOT NULL,
      order_idx INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      parsed INTEGER NOT NULL,
      record_count INTEGER NOT NULL,
      compressed_bad INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conflict_record (
      plugin TEXT NOT NULL REFERENCES conflict_plugin_scan(plugin) ON DELETE CASCADE,
      form_key TEXT NOT NULL,
      signature TEXT NOT NULL,
      data_crc INTEGER NOT NULL,
      edid TEXT,
      is_own INTEGER NOT NULL,
      PRIMARY KEY (plugin, form_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_conflict_record_form_key ON conflict_record(form_key);
    CREATE TABLE IF NOT EXISTS conflict_ignore (
      form_key TEXT PRIMARY KEY,
      reason TEXT,
      created_ms INTEGER NOT NULL
    );
  `)
}

export interface ConflictPluginInput {
  /** Nome file del plugin (con case originale), es. "Ordinator.esp". */
  name: string
  /** Path assoluto del file sul disco (Data deployata). */
  path: string
}

export interface IndexProgress {
  done: number
  total: number
  plugin: string
  cached: boolean
}

export interface IndexSummary {
  /** Plugin riscansionati binariamente in questo run. */
  indexed: number
  /** Plugin saltati perché (size, mtime) invariati. */
  cached: number
  /** Plugin non indicizzabili (I/O fallito o parse incompleto) — esclusi dall'analisi. */
  failed: string[]
  totalRecords: number
}

interface ScanRow {
  size: number
  mtime_ms: number
  parsed: number
}

/**
 * Fase di preparazione condivisa dai due driver (sync/async): schema, mappa light,
 * potatura dei plugin spariti, statement preparati. Ritorna la step-function per-plugin
 * e il summary che i driver accumulano.
 */
function prepareIndexRun(
  db: SqliteDb,
  pluginsInOrder: ConflictPluginInput[],
): { step: (p: ConflictPluginInput, orderIdx: number) => boolean; summary: IndexSummary } {
  ensureConflictSchema(db)

  // Mappa light di TUTTO il load order prima di scansionare: il mask delle chiavi di un
  // plugin dipende dalla lightness dei suoi MASTER, non solo di sé stesso. Header-only
  // read (pochi KB a file), costo trascurabile anche su ~2000 plugin.
  const lightByName = new Map<string, boolean>()
  for (const p of pluginsInOrder) {
    const header = readPluginHeader(p.path)
    lightByName.set(p.name.toLowerCase(), isLightSpace(p.name, header?.isLight))
  }
  const isLight = (name: string) => lightByName.get(name.toLowerCase())

  // Pota i plugin non più nel load order (differenza calcolata in JS: nessun limite di
  // placeholder, nessun SQL costruito dinamicamente).
  const inOrder = new Set(pluginsInOrder.map((p) => p.name.toLowerCase()))
  const known = db.prepare('SELECT plugin FROM conflict_plugin_scan').all() as { plugin: string }[]
  const stale = known.map((r) => r.plugin).filter((name) => !inOrder.has(name))
  if (stale.length > 0) {
    withTransaction(db, () => {
      const delRec = db.prepare('DELETE FROM conflict_record WHERE plugin = ?')
      const delScan = db.prepare('DELETE FROM conflict_plugin_scan WHERE plugin = ?')
      for (const name of stale) {
        delRec.run(name)
        delScan.run(name)
      }
    })
  }

  const selScan = db.prepare('SELECT size, mtime_ms, parsed FROM conflict_plugin_scan WHERE plugin = ?')
  const updOrder = db.prepare(
    'UPDATE conflict_plugin_scan SET order_idx = ?, path = ?, display_name = ? WHERE plugin = ?',
  )
  const upsertScan = db.prepare(
    `INSERT OR REPLACE INTO conflict_plugin_scan
       (plugin, display_name, path, order_idx, size, mtime_ms, parsed, record_count, compressed_bad)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const delRecords = db.prepare('DELETE FROM conflict_record WHERE plugin = ?')
  const insRecord = db.prepare(
    `INSERT OR REPLACE INTO conflict_record (plugin, form_key, signature, data_crc, edid, is_own)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  const summary: IndexSummary = { indexed: 0, cached: 0, failed: [], totalRecords: 0 }

  // Ritorna true se il plugin era in cache (nessuna rilettura binaria).
  const step = (p: ConflictPluginInput, orderIdx: number): boolean => {
    const key = p.name.toLowerCase()
    let size: number
    let mtimeMs: number
    try {
      const st = statSync(p.path)
      size = st.size
      mtimeMs = Math.trunc(st.mtimeMs)
    } catch {
      // File sparito: rimuovi eventuali righe cache, il conflitto non deve basarsi su fantasmi.
      withTransaction(db, () => {
        delRecords.run(key)
        db.prepare('DELETE FROM conflict_plugin_scan WHERE plugin = ?').run(key)
      })
      summary.failed.push(p.name)
      return false
    }

    const prev = selScan.get(key) as ScanRow | undefined
    if (prev && prev.parsed === 1 && prev.size === size && prev.mtime_ms === mtimeMs) {
      updOrder.run(orderIdx, p.path, p.name, key)
      summary.cached++
      return true
    }

    // Rescan binario. I record vengono bufferizzati e scritti SOLO se il parse arriva
    // pulito a fine file: un indice parziale è peggio di nessun indice.
    let rows: ScannedRecord[] = []
    let parsedOk = false
    let compressedBad = 0
    let masters: string[] = []
    try {
      const buf = readFileSync(p.path)
      const result = scanRecordsForConflicts(buf, (r) => rows.push(r))
      parsedOk = result.parsed
      compressedBad = result.compressedBadCount
      masters = result.header?.masters ?? []
    } catch {
      parsedOk = false
    }
    if (!parsedOk) rows = []

    const ctx = { pluginName: p.name, masters, isLight }
    withTransaction(db, () => {
      delRecords.run(key)
      upsertScan.run(
        key,
        p.name,
        p.path,
        orderIdx,
        size,
        mtimeMs,
        parsedOk ? 1 : 0,
        rows.length,
        compressedBad,
      )
      for (const r of rows) {
        const resolved = resolveFormKey(r.formId, ctx)
        insRecord.run(key, resolved.key, r.signature, r.dataCrc, r.edid, resolved.isOwn ? 1 : 0)
      }
    })

    if (parsedOk) {
      summary.indexed++
      summary.totalRecords += rows.length
    } else {
      summary.failed.push(p.name)
    }
    return false
  }

  return { step, summary }
}

/**
 * (Ri)costruisce l'indice per il load order dato (ordinato: indice = priorità di caricamento).
 * I plugin spariti dal load order vengono potati; quelli invariati non vengono riletti.
 * Driver SINCRONO: usato dai test e da contesti già fuori dal main thread.
 */
export function indexLoadOrder(
  db: SqliteDb,
  pluginsInOrder: ConflictPluginInput[],
  onProgress?: (p: IndexProgress) => void,
): IndexSummary {
  const { step, summary } = prepareIndexRun(db, pluginsInOrder)
  pluginsInOrder.forEach((p, orderIdx) => {
    const cached = step(p, orderIdx)
    onProgress?.({ done: orderIdx + 1, total: pluginsInOrder.length, plugin: p.name, cached })
  })
  return summary
}

/**
 * Driver ASINCRONO per il main process di Electron: identica semantica del sincrono ma
 * cede l'event loop tra un plugin e l'altro (setImmediate), così IPC/finestra restano
 * reattivi anche durante un cold scan da ~GB. La scansione del SINGOLO plugin resta
 * sincrona (il file più grosso, Skyrim.esm, costa poche centinaia di ms).
 */
export async function indexLoadOrderAsync(
  db: SqliteDb,
  pluginsInOrder: ConflictPluginInput[],
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexSummary> {
  const { step, summary } = prepareIndexRun(db, pluginsInOrder)
  for (let orderIdx = 0; orderIdx < pluginsInOrder.length; orderIdx++) {
    const p = pluginsInOrder[orderIdx]
    const cached = step(p, orderIdx)
    onProgress?.({ done: orderIdx + 1, total: pluginsInOrder.length, plugin: p.name, cached })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return summary
}

export interface ConflictParticipant {
  /** Nome file lowercase (chiave interna). */
  plugin: string
  displayName: string
  orderIdx: number
  dataCrc: number
  isOwn: boolean
}

export interface ConflictEntry {
  formKey: string
  signature: string
  edid: string | null
  /** Partecipanti in ordine di caricamento (l'ultimo vince a runtime). */
  participants: ConflictParticipant[]
  /** true = tutti gli override (esclusa l'eventuale patch) hanno lo stesso CRC: nessuna scelta da fare. */
  identicalOverrides: boolean
}

export interface ListConflictsOptions {
  /**
   * Plugin (es. la patch di risoluzione) ESCLUSO dal conteggio che decide se una form_key
   * è un conflitto: base + un mod + la patch NON è un conflitto tra mod, è la patch che
   * edita. Le sue righe restano comunque tra i partecipanti per il tracking.
   */
  excludeFromCount?: string
}

/** Elenca le form_key con >= 2 override da plugin distinti (patch eventualmente esclusa dal conteggio). */
export function listConflicts(db: SqliteDb, opts: ListConflictsOptions = {}): ConflictEntry[] {
  ensureConflictSchema(db)
  const excluded = opts.excludeFromCount?.toLowerCase() ?? null

  // Prefiltro SQL grezzo (>= 2 override totali), raffinato in JS per l'esclusione patch:
  // tiene il result set piccolo (solo chiavi contese) senza SQL dinamico.
  const rows = db
    .prepare(
      `SELECT r.form_key, r.plugin, r.signature, r.data_crc, r.edid, r.is_own,
              p.order_idx, p.display_name
         FROM conflict_record r
         JOIN conflict_plugin_scan p ON p.plugin = r.plugin
        WHERE r.form_key IN (
                SELECT form_key FROM conflict_record
                 WHERE is_own = 0
                 GROUP BY form_key
                HAVING COUNT(*) >= 2
              )
        ORDER BY r.form_key, p.order_idx`,
    )
    .all() as {
    form_key: string
    plugin: string
    signature: string
    data_crc: number
    edid: string | null
    is_own: number
    order_idx: number
    display_name: string
  }[]

  const out: ConflictEntry[] = []
  let i = 0
  while (i < rows.length) {
    const formKey = rows[i].form_key
    const participants: ConflictParticipant[] = []
    let edid: string | null = null
    let signature = rows[i].signature
    for (; i < rows.length && rows[i].form_key === formKey; i++) {
      const r = rows[i]
      participants.push({
        plugin: r.plugin,
        displayName: r.display_name,
        orderIdx: r.order_idx,
        dataCrc: r.data_crc >>> 0,
        isOwn: r.is_own === 1,
      })
      if (edid === null && r.edid) edid = r.edid
      // La signature dell'origine è la più autorevole (gli override la ripetono comunque).
      if (r.is_own === 1) signature = r.signature
    }
    const overrides = participants.filter((p) => !p.isOwn && p.plugin !== excluded)
    if (overrides.length < 2) continue
    const crcs = new Set(overrides.map((p) => p.dataCrc))
    out.push({ formKey, signature, edid, participants, identicalOverrides: crcs.size === 1 })
  }
  return out
}
