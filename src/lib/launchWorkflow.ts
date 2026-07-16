// Pure launch pre-flight workflow (renderer + main + tests). Evaluates a
// serializable environment snapshot through the recommended ordered stages and
// decides whether launch is allowed. COMPANION MODE: this never mutates Steam or
// the game — it only reads, verifies, and blocks with actionable fix messages.

import { LOAD_ORDER_LIMIT, LOAD_ORDER_WARN } from './modUtils'

export const SKYRIM_SE_APPID = 489830

export type CheckStatus = 'ok' | 'warning' | 'fail' | 'skipped'

export type LaunchStage =
  | 'PreFlightCheck'
  | 'VerifySteam'
  | 'VerifySkyrim'
  | 'VerifySKSE'
  | 'VerifyDependencies'
  | 'VerifyModlist'
  | 'VerifyLoadOrder'
  | 'VerifyManifest'
  | 'VerifyBackups'
  | 'LaunchMO2OrSKSE'

export interface LaunchCheck {
  stage: LaunchStage
  status: CheckStatus
  label: string
  detail: string
  fix?: string
  critical: boolean
}

export interface LaunchEnv {
  steam: { installed: boolean; running: boolean; path: string | null; libraries: string[] }
  skyrim: { appId: number; installed: boolean; path: string | null; version: string | null }
  skse: { present: boolean; version: string | null; gameVersionSupported: boolean | null }
  addressLibrary: { present: boolean; correctForVersion: boolean | null }
  mo2: { path: string | null; valid: boolean }
  mods: { total: number; enabled: number; installed: number }
  plugins: { name: string; enabled: boolean }[]
  modlist: { complete: boolean; missing: string[] }
  manifest: { used: boolean; verified: boolean; reason: string | null }
  backups: { count: number; lastValid: boolean }
  launchTarget: 'mo2' | 'skse' | null
  /** Protezione aggiornamenti Steam (opzionale: assente = probe non eseguita). */
  updateGuard?: {
    found: boolean
    protected: boolean
    /** null = drift non decidibile (prima esecuzione o versione ignota). */
    drift: { changed: boolean; from: string | null; to: string | null } | null
  }
  /** Verifica external-changes del deploy (manifest vs disco); assente = non eseguita. */
  deployIntegrity?: {
    checked: boolean
    totalFiles: number
    missingCount: number
    replacedCount: number
    junctionsMissingCount: number
  }
  /** Diagnosi ultimo salvataggio vs load order attivo; assente = non eseguita. */
  saveDoctor?: {
    checked: boolean
    saveName: string | null
    missingCount: number
    missingPlugins: string[]
  }
}

export interface LaunchReport {
  checks: LaunchCheck[]
  canLaunch: boolean
  blockingStage: LaunchStage | null
  firstFix: string | null
  totals: { ok: number; warning: number; fail: number; skipped: number }
}

function countFullSlots(plugins: { name: string; enabled: boolean }[]): number {
  return plugins.filter((p) => p.enabled && /\.(esp|esm)$/i.test(p.name) && !/\.esl$/i.test(p.name)).length
}

export function runLaunchWorkflow(env: LaunchEnv): LaunchReport {
  const c: LaunchCheck[] = []
  const ok = (stage: LaunchStage, label: string, detail: string): LaunchCheck => ({
    stage,
    status: 'ok',
    label,
    detail,
    critical: false,
  })
  const warn = (stage: LaunchStage, label: string, detail: string, fix: string): LaunchCheck => ({
    stage,
    status: 'warning',
    label,
    detail,
    fix,
    critical: false,
  })
  const fail = (stage: LaunchStage, label: string, detail: string, fix: string): LaunchCheck => ({
    stage,
    status: 'fail',
    label,
    detail,
    fix,
    critical: true,
  })

  // 1. PreFlightCheck — umbrella entry
  c.push(ok('PreFlightCheck', 'Avvio controlli', 'Verifica prerequisiti in corso'))

  // 2. VerifySteam
  if (!env.steam.installed)
    c.push(
      fail(
        'VerifySteam',
        'Steam non rilevato',
        'Installazione di Steam non trovata',
        'Installa Steam da store.steampowered.com',
      ),
    )
  else if (!env.steam.running)
    c.push(
      warn(
        'VerifySteam',
        'Steam non in esecuzione',
        'Steam risulta chiuso',
        'Avvia Steam prima di lanciare il gioco',
      ),
    )
  else c.push(ok('VerifySteam', 'Steam pronto', `In esecuzione · ${env.steam.libraries.length} libreria/e`))

  // 3. VerifySkyrim (AppID 489830 install manifest present)
  if (!env.skyrim.installed)
    c.push(
      fail(
        'VerifySkyrim',
        'Skyrim non installato',
        `Nessun appmanifest_${env.skyrim.appId}.acf nelle librerie Steam`,
        'Installa Skyrim Special/Anniversary Edition da Steam',
      ),
    )
  else
    c.push(
      ok(
        'VerifySkyrim',
        'Skyrim AE rilevato',
        `${env.skyrim.path ?? 'percorso noto'}${env.skyrim.version ? ` · v${env.skyrim.version}` : ''}`,
      ),
    )

  // 3b. Update guard (probe opzionale): drift di versione = update Steam avvenuto (spiega
  // PERCHÉ SKSE potrebbe fallire al check successivo); non protetto = rischio latente.
  if (env.updateGuard && env.skyrim.installed) {
    const g = env.updateGuard
    if (g.drift?.changed)
      c.push(
        warn(
          'VerifySkyrim',
          'Skyrim aggiornato da Steam',
          `Runtime cambiato: ${g.drift.from} → ${g.drift.to}. I plugin SKSE compilati per la versione precedente potrebbero non caricare`,
          'Aggiorna SKSE e Address Library al nuovo runtime, oppure ripristina la versione precedente',
        ),
      )
    else if (g.found && !g.protected)
      c.push(
        warn(
          'VerifySkyrim',
          'Aggiornamenti Steam non bloccati',
          'Steam può aggiornare Skyrim in qualsiasi momento e rompere SKSE + plugin nativi',
          'Attiva la protezione aggiornamenti nelle Impostazioni',
        ),
      )
    else if (g.found && g.protected)
      c.push(ok('VerifySkyrim', 'Protezione aggiornamenti attiva', 'Steam non può aggiornare il runtime moddato'))
  }

  // 4. VerifySKSE
  if (!env.skse.present)
    c.push(
      fail(
        'VerifySKSE',
        'SKSE64 mancante',
        'Script Extender non rilevato nella cartella di gioco',
        'Installa SKSE64 per la tua versione di Skyrim AE (skse.silverlock.org)',
      ),
    )
  else if (env.skse.gameVersionSupported === false)
    c.push(
      fail(
        'VerifySKSE',
        'SKSE incompatibile',
        `SKSE ${env.skse.version ?? '?'} non supporta questa versione di Skyrim`,
        'Aggiorna SKSE alla build corrispondente al runtime di Skyrim',
      ),
    )
  else c.push(ok('VerifySKSE', 'SKSE64 ok', `v${env.skse.version ?? '?'}`))

  // 5. VerifyDependencies (Address Library — the SKSE-plugin prerequisite)
  if (!env.addressLibrary.present)
    c.push(
      fail(
        'VerifyDependencies',
        'Address Library mancante',
        'Richiesta da quasi tutti i plugin SKSE',
        'Installa "Address Library for SKSE Plugins" (versione per AE)',
      ),
    )
  else if (env.addressLibrary.correctForVersion === false)
    c.push(
      fail(
        'VerifyDependencies',
        'Address Library errata',
        'Versione di Address Library non corrispondente al runtime',
        'Installa la build di Address Library per la tua versione di Skyrim',
      ),
    )
  else c.push(ok('VerifyDependencies', 'Dipendenze base ok', 'Address Library presente'))

  // 6. VerifyModlist (completeness — non-blocking)
  if (!env.modlist.complete)
    c.push(
      warn(
        'VerifyModlist',
        'Modlist incompleta',
        `${env.modlist.missing.length} mod attese non installate`,
        `Installa le mod mancanti: ${env.modlist.missing.slice(0, 5).join(', ')}${env.modlist.missing.length > 5 ? '…' : ''}`,
      ),
    )
  else c.push(ok('VerifyModlist', 'Modlist completa', `${env.mods.installed}/${env.mods.total} installate`))

  // 7. VerifyLoadOrder (ESP/ESM hard limit)
  const slots = countFullSlots(env.plugins)
  if (slots > LOAD_ORDER_LIMIT)
    c.push(
      fail(
        'VerifyLoadOrder',
        'Limite load order superato',
        `${slots} plugin ESP/ESM attivi (max ${LOAD_ORDER_LIMIT})`,
        'Disattiva o converti in ESL alcuni plugin',
      ),
    )
  else if (slots > LOAD_ORDER_WARN)
    c.push(
      warn(
        'VerifyLoadOrder',
        'Load order vicino al limite',
        `${slots}/${LOAD_ORDER_LIMIT} slot usati`,
        'Valuta la conversione di alcuni plugin in ESL',
      ),
    )
  else c.push(ok('VerifyLoadOrder', 'Load order ok', `${slots}/${LOAD_ORDER_LIMIT} slot`))

  // 8. VerifyManifest (delta integrity — skipped if delta not in use)
  if (!env.manifest.used)
    c.push({
      stage: 'VerifyManifest',
      status: 'skipped',
      label: 'Manifest delta non in uso',
      detail: 'Nessun aggiornamento incrementale attivo',
      critical: false,
    })
  else if (!env.manifest.verified)
    c.push(
      warn(
        'VerifyManifest',
        'Manifest non verificato',
        env.manifest.reason ?? 'Firma/integrità non confermata',
        'Riscarica il manifest firmato o controlla la chiave',
      ),
    )
  else c.push(ok('VerifyManifest', 'Manifest verificato', 'Firma e integrità ok'))

  // 8b. Integrità del deploy (external changes): il manifest è la verità di cosa abbiamo
  // linkato — file spariti/sostituiti da tool esterni emergono QUI, non come CTD nel gioco.
  if (env.deployIntegrity?.checked) {
    const di = env.deployIntegrity
    const issues = di.missingCount + di.replacedCount + di.junctionsMissingCount
    if (issues > 0) {
      const parts: string[] = []
      if (di.missingCount) parts.push(`${di.missingCount} file mancanti`)
      if (di.replacedCount) parts.push(`${di.replacedCount} sostituiti esternamente`)
      if (di.junctionsMissingCount) parts.push(`${di.junctionsMissingCount} junction scollegate`)
      c.push(
        warn(
          'VerifyManifest',
          'Deploy alterato esternamente',
          parts.join(', '),
          'Riesegui il Deploy dalla Dashboard per ripristinare i collegamenti',
        ),
      )
    } else
      c.push(ok('VerifyManifest', 'Deploy integro', `${di.totalFiles} file del manifest verificati sul disco`))
  }

  // 8c. Save Doctor: l'ultimo salvataggio referenzia plugin non più nel load order →
  // CTD al load o progressione corrotta. Diagnosi read-only, warning mai bloccante.
  if (env.saveDoctor?.checked && env.saveDoctor.missingCount > 0) {
    const sd = env.saveDoctor
    const sample = sd.missingPlugins.slice(0, 3).join(', ')
    c.push(
      warn(
        'VerifyLoadOrder',
        'Ultimo salvataggio a rischio',
        `${sd.saveName ?? 'save'} richiede ${sd.missingCount} plugin assenti dal load order (${sample}${sd.missingCount > 3 ? ', …' : ''})`,
        'Reinstalla/riattiva le mod mancanti, oppure prosegui solo con una nuova partita',
      ),
    )
  } else if (env.saveDoctor?.checked) {
    c.push(ok('VerifyLoadOrder', 'Salvataggio coerente', 'Tutti i plugin dell’ultimo save sono presenti'))
  }

  // 9. VerifyBackups (recommended)
  if (env.backups.count === 0)
    c.push(
      warn(
        'VerifyBackups',
        'Nessun backup',
        'Non esistono punti di ripristino del profilo',
        'Crea un backup prima di avviare/aggiornare',
      ),
    )
  else if (!env.backups.lastValid)
    c.push(
      warn(
        'VerifyBackups',
        'Ultimo backup non valido',
        'Il checksum del backup più recente non corrisponde',
        'Crea un nuovo backup valido',
      ),
    )
  else c.push(ok('VerifyBackups', 'Backup disponibili', `${env.backups.count} punto/i di ripristino`))

  // 10. LaunchMO2OrSKSE (target resolution)
  if (env.launchTarget === null)
    c.push(
      fail(
        'LaunchMO2OrSKSE',
        'Nessun target di avvio',
        'MO2 e SKSE non configurati',
        'Configura il percorso di Mod Organizer 2 nelle Impostazioni',
      ),
    )
  else if (env.launchTarget === 'mo2' && !env.mo2.valid)
    c.push(
      fail(
        'LaunchMO2OrSKSE',
        'Percorso MO2 non valido',
        `ModOrganizer.exe non trovato: ${env.mo2.path ?? '(vuoto)'}`,
        'Reimposta il percorso di Mod Organizer 2',
      ),
    )
  else
    c.push(
      ok(
        'LaunchMO2OrSKSE',
        'Pronto al lancio',
        env.launchTarget === 'mo2' ? 'Avvio tramite Mod Organizer 2' : 'Avvio tramite SKSE',
      ),
    )

  const blocking = c.find((x) => x.status === 'fail' && x.critical) ?? null
  const totals = {
    ok: c.filter((x) => x.status === 'ok').length,
    warning: c.filter((x) => x.status === 'warning').length,
    fail: c.filter((x) => x.status === 'fail').length,
    skipped: c.filter((x) => x.status === 'skipped').length,
  }
  return {
    checks: c,
    canLaunch: !blocking,
    blockingStage: blocking?.stage ?? null,
    firstFix: blocking?.fix ?? null,
    totals,
  }
}
