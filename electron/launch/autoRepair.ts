// Riparazione automatica pre-avvio — il pezzo che mancava per l'esperienza "stile Nolvus":
// premi GIOCA e il sistema si mette a posto da solo, invece di bloccarti con un consiglio.
//
// La pipeline di avvio era fatta di soli stadi `Verify*`: verificava e sbarrava la strada.
// Ogni problema riparabile in modo deterministico veniva scaricato sull'utente ("clicca
// Deploy", "registra le estratte"). Questo modulo esegue quelle riparazioni da sé, PRIMA
// che le verifiche girino, così il verdetto le vede già risolte.
//
// Cosa ripara, in ordine (ogni passo è idempotente — a sistema già a posto non fa nulla):
//   1. REGISTRA — mod estratte su disco ma assenti dal DB: il deploy legge `is_installed`,
//      quindi senza questo passo non le collegherebbe mai.
//   2. DEPLOY — nessun manifest (mai distribuito) o deriva rilevata (file cancellati o
//      sostituiti da tool esterni): ridistribuisce. È QUI che avvengono ordinamento
//      topologico dei plugin, regole LOOT e scrittura di plugins.txt: fare il deploy
//      È l'ordinamento e l'attivazione automatici dei plugin.
//
// Sicurezza: `backup` (opzionale) viene invocato PRIMA di un deploy automatico, così una
// riparazione non richiesta esplicitamente resta sempre annullabile.
//
// PURO: ogni IO è iniettato. Mai throw — un dep che lancia diventa un'azione fallita.

export interface RepairAction {
  id: 'register' | 'backup' | 'deploy'
  label: string
  /** true = l'azione ha CAMBIATO qualcosa; false = era già a posto (no-op). */
  changed: boolean
  detail: string
  error?: string
}

export interface AutoRepairResult {
  /** false = riparazione disattivata dall'utente: la pipeline prosegue senza toccare nulla. */
  enabled: boolean
  actions: RepairAction[]
  /** true = almeno un'azione ha modificato lo stato → l'ambiente va rivalutato. */
  changed: boolean
  /** true = una riparazione necessaria è fallita (la pipeline prosegue: le verifiche decidono). */
  failed: boolean
  summary: string
}

export interface DeployDrift {
  /** false = nessun manifest: mai distribuito → il deploy serve. */
  checked: boolean
  missingCount: number
  replacedCount: number
  junctionsMissingCount: number
}

export interface AutoRepairDeps {
  /** false → salta tutto (impostazione utente). */
  enabled: () => boolean
  /** Registra come installate le mod estratte su disco. null = passo non disponibile. */
  registerInstalled?: () => { inserted: number; updated: number } | null
  /** Stato del deploy corrente rispetto al manifest. null = non determinabile. */
  verifyDeploy?: () => DeployDrift | null
  /** Ridistribuisce (ordina i plugin + scrive plugins.txt). */
  deploy?: () => Promise<{ success: boolean; modsLinked?: number; pluginsWritten?: number; error?: string }>
  /** Punto di ripristino prima di un deploy automatico (se l'utente lo vuole). */
  backup?: () => Promise<{ success: boolean; error?: string }>
  log?: (msg: string) => void
}

/** true quando il deploy va (ri)eseguito: mai distribuito, oppure derivato. */
export function deployNeeded(d: DeployDrift | null): { needed: boolean; reason: string } {
  if (!d) return { needed: false, reason: 'stato del deploy non determinabile' }
  if (!d.checked) return { needed: true, reason: 'mod mai collegate al gioco' }
  const drift = d.missingCount + d.replacedCount + d.junctionsMissingCount
  if (drift > 0) {
    const parts: string[] = []
    if (d.missingCount) parts.push(`${d.missingCount} file mancanti`)
    if (d.replacedCount) parts.push(`${d.replacedCount} sostituiti esternamente`)
    if (d.junctionsMissingCount) parts.push(`${d.junctionsMissingCount} junction scollegate`)
    return { needed: true, reason: parts.join(', ') }
  }
  return { needed: false, reason: 'deploy integro' }
}

export async function runAutoRepair(deps: AutoRepairDeps): Promise<AutoRepairResult> {
  if (!deps.enabled()) {
    return {
      enabled: false,
      actions: [],
      changed: false,
      failed: false,
      summary: 'Riparazione automatica disattivata',
    }
  }

  const actions: RepairAction[] = []
  const add = (a: RepairAction): RepairAction => {
    actions.push(a)
    if (a.changed || a.error) deps.log?.(`${a.label}: ${a.error ? `FALLITO — ${a.error}` : a.detail}`)
    return a
  }

  // 1. Registra le estrazioni non ancora note al DB (il deploy legge is_installed).
  if (deps.registerInstalled) {
    try {
      const r = deps.registerInstalled()
      const n = (r?.inserted ?? 0) + (r?.updated ?? 0)
      add({
        id: 'register',
        label: 'Registrazione mod estratte',
        changed: n > 0,
        detail: n > 0 ? `${n} mod registrate come installate` : 'nessuna nuova estrazione da registrare',
      })
    } catch (e) {
      add({
        id: 'register',
        label: 'Registrazione mod estratte',
        changed: false,
        detail: 'fallita',
        error: (e as Error).message,
      })
    }
  }

  // 2. Deploy quando serve — è anche l'ordinamento+attivazione automatici dei plugin.
  let drift: DeployDrift | null = null
  try {
    drift = deps.verifyDeploy?.() ?? null
  } catch (e) {
    deps.log?.(`verifica deploy fallita: ${(e as Error).message}`)
    drift = null
  }
  const { needed, reason } = deployNeeded(drift)

  if (needed && deps.deploy) {
    // Punto di ripristino prima di toccare la Data del gioco senza che l'utente l'abbia chiesto.
    if (deps.backup) {
      try {
        const b = await deps.backup()
        add({
          id: 'backup',
          label: 'Backup di sicurezza',
          changed: b.success,
          detail: b.success ? 'punto di ripristino creato' : 'non creato',
          error: b.success ? undefined : b.error,
        })
      } catch (e) {
        add({
          id: 'backup',
          label: 'Backup di sicurezza',
          changed: false,
          detail: 'fallito',
          error: (e as Error).message,
        })
      }
    }
    try {
      const d = await deps.deploy()
      add({
        id: 'deploy',
        label: 'Collegamento mod e ordinamento plugin',
        changed: d.success,
        detail: d.success
          ? `${reason} → ${d.modsLinked ?? 0} mod collegate, ${d.pluginsWritten ?? 0} plugin ordinati e attivati`
          : 'deploy non riuscito',
        error: d.success ? undefined : (d.error ?? 'errore sconosciuto'),
      })
    } catch (e) {
      add({
        id: 'deploy',
        label: 'Collegamento mod e ordinamento plugin',
        changed: false,
        detail: 'deploy non riuscito',
        error: (e as Error).message,
      })
    }
  } else if (deps.deploy) {
    add({ id: 'deploy', label: 'Collegamento mod e ordinamento plugin', changed: false, detail: reason })
  }

  const changed = actions.some((a) => a.changed)
  const failed = actions.some((a) => !!a.error)
  const done = actions.filter((a) => a.changed).map((a) => a.detail)
  const summary = failed
    ? `Riparazione parziale: ${actions.find((a) => a.error)?.error ?? 'errore'}`
    : changed
      ? `Riparato: ${done.join(' · ')}`
      : 'Nessuna riparazione necessaria'

  return { enabled: true, actions, changed, failed, summary }
}
