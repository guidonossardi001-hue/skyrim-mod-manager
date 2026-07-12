// Validazione dello schema di download (data-integrity check). PURA e fail-safe: le entry
// invalide vengono FLAGGATE ed ESCLUSE dalla coda di installazione (mai un throw) — meglio una
// mod in meno nel run che un fetch destinato a timeout/404 che consuma retry e circuit breaker.
//
// "URL di download diretto" in questa architettura: il link CDN Nexus è firmato e a scadenza,
// quindi NON è persistibile — si deriva a runtime da (modId, fileId) via l'endpoint
// download_link.json. Perciò per la CODA il requisito equivalente è: modId E fileId validi.
// Per le righe di CATALOGO esiste anche la colonna `nexus_download_url` (URL diretto esplicito):
// una riga è installabile se ha nexus_file_id OPPURE nexus_download_url.

export type DownloadSchemaIssue =
  | 'missing-mod-id' // modId assente/non intero/≤0 → nessuna API interrogabile
  | 'missing-file-id' // fileId assente → impossibile derivare il download link diretto
  | 'bad-md5' // md5 presente ma malformato → la verifica integrità fallirebbe SEMPRE
  | 'bad-size' // fileSize presente ma non finito/≤0 → solo flag (il disk gate resta l'autorità)

/** Issue che escludono l'entry dalla coda (hard). 'bad-size' è solo informativa. */
const HARD_ISSUES: ReadonlySet<DownloadSchemaIssue> = new Set([
  'missing-mod-id',
  'missing-file-id',
  'bad-md5',
])

const MD5_RE = /^[0-9a-f]{32}$/i

export interface QueueEntryLike {
  modId?: number
  fileId?: number
  name?: string
  md5?: string | null
  fileSize?: number
}

export interface InvalidEntry {
  modId: number | null
  name: string
  issues: DownloadSchemaIssue[]
}

export interface DownloadValidation<T> {
  valid: T[]
  /** Entry con almeno una issue HARD: flaggate ed escluse dalla coda. */
  invalid: InvalidEntry[]
  /** Entry tenute in coda ma con issue soft (es. bad-size), per il log. */
  warnings: InvalidEntry[]
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

export function validateQueueEntry(m: QueueEntryLike): DownloadSchemaIssue[] {
  const issues: DownloadSchemaIssue[] = []
  if (!isPosInt(m.modId)) issues.push('missing-mod-id')
  if (!isPosInt(m.fileId)) issues.push('missing-file-id')
  if (m.md5 != null && m.md5 !== '' && !MD5_RE.test(m.md5)) issues.push('bad-md5')
  if (m.fileSize != null && !(Number.isFinite(m.fileSize) && m.fileSize > 0)) issues.push('bad-size')
  return issues
}

/** Split fail-safe della sorgente sync: `valid` prosegue verso la coda, `invalid` viene escluso
 *  e riportato nei log. Nessuna eccezione: dati sporchi ⇒ entry scartata, mai run abortito. */
export function validateDownloadSchema<T extends QueueEntryLike>(mods: T[]): DownloadValidation<T> {
  const valid: T[] = []
  const invalid: InvalidEntry[] = []
  const warnings: InvalidEntry[] = []
  for (const m of mods) {
    const issues = validateQueueEntry(m)
    const entry: InvalidEntry = {
      modId: isPosInt(m.modId) ? m.modId : null,
      name: (m.name ?? '').toString() || '(senza nome)',
      issues,
    }
    if (issues.some((i) => HARD_ISSUES.has(i))) invalid.push(entry)
    else {
      valid.push(m)
      if (issues.length) warnings.push(entry)
    }
  }
  return { valid, invalid, warnings }
}

/** Riga di modlist_catalog per il check "URL diretto derivabile". */
export interface CatalogRowLike {
  nexus_id?: number | null
  name?: string | null
  nexus_file_id?: number | null
  nexus_download_url?: string | null
}

export interface CatalogLinkReport {
  checked: number
  /** Righe installabili: nexus_id valido E (nexus_file_id valido O nexus_download_url http(s)). */
  ok: number
  /** Righe flaggate invalid/missing-url (log-only: il catalogo è una vetrina, non la coda). */
  missingUrl: Array<{ nexus_id: number | null; name: string }>
  badModId: Array<{ nexus_id: number | null; name: string }>
}

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== 'string' || !v.trim()) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export function validateCatalogLinks(rows: CatalogRowLike[]): CatalogLinkReport {
  const report: CatalogLinkReport = { checked: rows.length, ok: 0, missingUrl: [], badModId: [] }
  for (const r of rows) {
    const name = (r.name ?? '').toString() || '(senza nome)'
    if (!isPosInt(r.nexus_id ?? undefined)) {
      report.badModId.push({ nexus_id: r.nexus_id ?? null, name })
      continue
    }
    if (isPosInt(r.nexus_file_id ?? undefined) || isHttpUrl(r.nexus_download_url)) report.ok++
    else report.missingUrl.push({ nexus_id: r.nexus_id ?? null, name })
  }
  return report
}

/** Riassunto compatto per i log (cap sugli id per non inondare la console). */
export function summarizeInvalid(entries: InvalidEntry[], cap = 10): string {
  const head = entries
    .slice(0, cap)
    .map((e) => `${e.modId ?? '?'}:${e.name} [${e.issues.join(',')}]`)
    .join(' · ')
  return entries.length > cap ? `${head} · +${entries.length - cap} altre` : head
}
