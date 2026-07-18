import { useEffect, useRef, useState } from 'react'
import { Link2, Trash2, Loader, FolderSync, ShieldCheck, Wrench } from 'lucide-react'
import { toast } from '@/lib/toast'

// Pannello Deployment (hardlink engine): consuma deploy:run / deploy:purge / deploy:progress.
// Prima questi IPC esistevano senza alcuna UI — il motore era invisibile all'utente.

interface DeployApi {
  deploy?: {
    run(profileId: number): Promise<{
      success: boolean
      modsLinked?: number
      filesHardlinked?: number
      junctionsCreated?: number
      pluginsWritten?: number
      systemPluginsPath?: string
      ccFilesLinked?: number
      conflictsResolved?: number
      dirtyPlugins?: { plugin: string; itm: number; udr: number; nav: number; util: string }[]
      skippedPlugins?: { plugin: string; masters: string[] }[]
      errorKind?: string
      error?: string
    }>
    purge(profileId: number): Promise<{
      success: boolean
      manifestFound: boolean
      filesRemoved: number
      junctionsRemoved: number
      dirsPruned: number
      skipped: number
      systemPluginsRestored: boolean
      error?: string
    }>
    onProgress(cb: (p: { stage: string; percent?: number; currentMod?: string; currentFile?: string }) => void): () => void
    verify?(): Promise<{
      checked: boolean
      totalFiles: number
      intactFiles: number
      missing: string[]
      replaced: string[]
      junctionsMissing: string[]
      missingCount: number
      replacedCount: number
      junctionsMissingCount: number
    }>
    resolveDrift?(
      profileId: number,
      rel: string,
      kind: 'file' | 'junction',
      action: 'restore' | 'accept',
    ): Promise<{ ok: boolean; action: 'restore' | 'accept'; rel: string; error?: string }>
  }
}

interface DriftItem {
  rel: string
  kind: 'file' | 'junction'
  label: string
}

interface SyncRegisterApi {
  sync?: {
    registerInstalled?: () => Promise<{
      ok: boolean
      found?: number
      inserted?: number
      updated?: number
      unchanged?: number
      error?: string
    }>
  }
}

const STAGE_LABEL: Record<string, string> = {
  scanning: 'Scansione mod',
  cleaning: 'Pulizia deploy precedente',
  linking: 'Creazione hardlink/junction',
  plugins: 'Scrittura plugins.txt',
  ini: 'Applicazione INI',
  done: 'Completato',
}

export function DeployPanel({ profileId, onLog }: { profileId: number | null; onLog: (msg: string, level?: string) => void }) {
  const [busy, setBusy] = useState<'deploy' | 'purge' | 'register' | 'verify' | null>(null)
  const [progress, setProgress] = useState<{ stage: string; percent?: number; detail?: string } | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  // Plugin "dirty" (ITM/UDR) segnalati dall'ultimo deploy — Quick Auto Clean automatizzato per
  // ognuno (T20), headless via xEdit/SSEEdit. Il gioco deve essere chiuso (gate lato main).
  const [dirtyPlugins, setDirtyPlugins] = useState<{ plugin: string; itm: number; udr: number; nav: number; util: string }[]>([])
  const [qacBusy, setQacBusy] = useState<string | null>(null)
  const [qacResults, setQacResults] = useState<Record<string, string>>({})
  // Drift esterno segnalato dall'ultima verify(): l'utente chiude ogni voce con Ripristina/Accetta.
  const [driftItems, setDriftItems] = useState<DriftItem[]>([])
  const [driftBusy, setDriftBusy] = useState<string | null>(null)
  const api = (window.api as unknown as DeployApi).deploy
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!api?.onProgress) return
    unsubRef.current = api.onProgress((p) => {
      setProgress({ stage: p.stage, percent: p.percent, detail: p.currentMod ?? p.currentFile })
    })
    return () => unsubRef.current?.()
  }, [api])

  if (!api) return null // preview senza mock deploy / build vecchia: pannello assente, mai rotto

  const runDeploy = async () => {
    if (profileId == null || busy) return
    if (
      !window.confirm(
        'Eseguire il Deploy?\n\nCollega (hardlink/junction) le mod abilitate nella cartella Data dell’istanza, risolve i conflitti per priorità e genera il load order (plugins.txt, anche di sistema). Le cartelle mod sorgente non vengono MAI modificate.',
      )
    )
      return
    setBusy('deploy')
    setSummary(null)
    try {
      const r = await api.run(profileId)
      if (r.success) {
        const line = `Deploy: ${r.modsLinked} mod → ${r.filesHardlinked} hardlink + ${r.junctionsCreated} junction · ${r.pluginsWritten} plugin${r.systemPluginsPath ? ' · plugins.txt di sistema scritto' : ''}${r.conflictsResolved ? ` · ${r.conflictsResolved} conflitti auto-risolti` : ''}`
        setSummary(line)
        onLog(line, 'success')
        toast.success('Deploy completato', `${r.filesHardlinked} hardlink, ${r.pluginsWritten} plugin nel load order`)
        setDirtyPlugins(r.dirtyPlugins ?? [])
        setQacResults({})
        if (r.dirtyPlugins?.length) {
          const names = r.dirtyPlugins.map((d) => `${d.plugin} (${d.itm} ITM, ${d.udr} UDR)`).join(', ')
          onLog(`Plugin da pulire con SSEEdit: ${names}`, 'error')
          toast.warning(`${r.dirtyPlugins.length} plugin da pulire`, names)
        }
        if (r.skippedPlugins?.length) {
          const names = r.skippedPlugins
            .map((s) => `${s.plugin} (richiede ${s.masters.join(', ')})`)
            .join('; ')
          onLog(`Plugin disattivati per master mancanti: ${names}`, 'error')
          toast.warning(
            `${r.skippedPlugins.length} plugin disattivati (master mancanti)`,
            `File deployati ma fuori dal load order: ${names}`,
          )
        }
      } else if (r.errorKind === 'dependency-cycle') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.error('Ciclo di dipendenze nei plugin', r.error ?? 'deploy bloccato per sicurezza')
      } else if (r.errorKind === 'missing-master') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.error('Master mancanti', r.error ?? 'un plugin richiede master non installati')
      } else if (r.errorKind === 'game-running') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.warning('Skyrim è in esecuzione', r.error ?? 'chiudi il gioco prima di eseguire il Deploy')
      } else if (r.errorKind === 'busy') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.warning('Operazione in corso', r.error ?? "un'altra operazione pesante è già attiva")
      } else {
        onLog(`Deploy fallito: ${r.error}`, 'error')
        toast.error('Deploy fallito', r.error ?? r.errorKind ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Deploy fallito', (e as Error).message)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  // Ponte StockGame → mods: registra le estrazioni esistenti come installate, così il Deploy le
  // vede. Utile una-tantum per le estrazioni storiche; i sync futuri registrano da soli.
  const registerApi = (window.api as unknown as SyncRegisterApi).sync?.registerInstalled
  const runRegister = async () => {
    if (busy || !registerApi) return
    setBusy('register')
    try {
      const r = await registerApi()
      if (r.ok) {
        const line = `Registrate estrazioni StockGame: ${r.found} trovate → ${r.inserted} nuove, ${r.updated} aggiornate, ${r.unchanged} già presenti`
        onLog(line, 'success')
        toast.success('Estrazioni registrate', `${r.found} mod pronte per il Deploy`)
      } else {
        toast.error('Registrazione fallita', r.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Registrazione fallita', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const runPurge = async () => {
    if (profileId == null || busy) return
    if (
      !window.confirm(
        'Eseguire il Purge?\n\nRimuove SOLO gli hardlink/junction creati dal deploy (tracciati nel manifest) e ripristina il plugins.txt di sistema originale. Le mod e il gioco base restano intatti.',
      )
    )
      return
    setBusy('purge')
    setSummary(null)
    try {
      const r = await api.purge(profileId)
      if (r.success) {
        const line = `Purge: ${r.filesRemoved} hardlink e ${r.junctionsRemoved} junction rimossi, ${r.dirsPruned} cartelle vuote potate${r.skipped ? `, ${r.skipped} file utente preservati` : ''}${r.systemPluginsRestored ? ' · plugins.txt di sistema ripristinato' : ''}`
        setSummary(line)
        onLog(line, 'success')
        toast.success('Purge completato', 'Istanza riportata allo stato pre-deploy')
      } else {
        onLog(`Purge fallito: ${r.error}`, 'error')
        toast.error('Purge fallito', r.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Purge fallito', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Verifica external-changes: manifest vs disco (sola lettura, mai modifica nulla).
  const runVerify = async () => {
    if (busy || !api.verify) return
    setBusy('verify')
    setDriftItems([])
    try {
      const r = await api.verify()
      if (!r.checked) {
        onLog('Verifica deploy: nessun manifest trovato (nessun deploy attivo)', 'warn')
        toast.info('Nessun deploy da verificare', 'Esegui prima un Deploy')
        return
      }
      const issues = r.missingCount + r.replacedCount + r.junctionsMissingCount
      if (issues === 0) {
        const line = `Verifica deploy: ${r.totalFiles} file integri, nessuna modifica esterna`
        setSummary(line)
        onLog(line)
        toast.success('Deploy integro', `${r.totalFiles} file verificati`)
      } else {
        const parts: string[] = []
        if (r.missingCount) parts.push(`${r.missingCount} mancanti (${r.missing.slice(0, 3).join(', ')}…)`)
        if (r.replacedCount) parts.push(`${r.replacedCount} sostituiti esternamente`)
        if (r.junctionsMissingCount) parts.push(`${r.junctionsMissingCount} junction scollegate`)
        const line = `Verifica deploy: ${parts.join(' · ')} — risolvi ogni voce sotto o riesegui il Deploy`
        setSummary(null)
        onLog(line, 'warn')
        toast.error('Deploy alterato esternamente', parts.join(' · '))
        setDriftItems([
          ...r.missing.map((rel): DriftItem => ({ rel, kind: 'file', label: `${rel} (mancante)` })),
          ...r.replaced.map((rel): DriftItem => ({ rel, kind: 'file', label: `${rel} (sostituito)` })),
          ...r.junctionsMissing.map((rel): DriftItem => ({ rel, kind: 'junction', label: `${rel}/ (junction scollegata)` })),
        ])
      }
    } catch (e) {
      toast.error('Verifica fallita', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Risoluzione mirata di UNA voce di drift: 'restore' ricollega il file gestito (vincitore
  // ricalcolato ORA), 'accept' riconosce lo stato esterno come intenzionale e lo esclude dalle
  // verifiche successive. Rimuove l'item dalla lista solo se il main conferma ok:true.
  const runResolveDrift = async (item: DriftItem, action: 'restore' | 'accept') => {
    if (profileId == null || driftBusy || !api.resolveDrift) return
    setDriftBusy(item.rel)
    try {
      const r = await api.resolveDrift(profileId, item.rel, item.kind, action)
      if (r.ok) {
        setDriftItems((prev) => prev.filter((d) => d.rel !== item.rel))
        onLog(`Drift risolto (${action === 'restore' ? 'ripristinato' : 'accettato'}): ${item.rel}`, 'success')
        toast.success(action === 'restore' ? 'File ripristinato' : 'Modifica esterna accettata', item.rel)
      } else {
        onLog(`Risoluzione drift fallita per "${item.rel}": ${r.error}`, 'error')
        toast.error('Risoluzione fallita', r.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Risoluzione fallita', (e as Error).message)
    } finally {
      setDriftBusy(null)
    }
  }

  // Quick Auto Clean headless (T20): un plugin alla volta, gate lato main su gioco in
  // esecuzione. Nessun exit-code contrattuale di xEdit — il main classifica dal log.
  const runQacClean = async (pluginName: string) => {
    if (qacBusy) return
    if (
      !window.confirm(
        `Pulire "${pluginName}" con SSEEdit (Quick Auto Clean)?\n\nApre xEdit in background e rimuove ITM/UDR automaticamente. Il gioco deve essere chiuso.`,
      )
    )
      return
    setQacBusy(pluginName)
    try {
      const r = await window.api.plugin.qacClean(pluginName)
      setQacResults((prev) => ({ ...prev, [pluginName]: r.summary }))
      if (r.verdict === 'cleaned') toast.success(`${pluginName} pulito`, r.summary)
      else if (r.verdict === 'nothing-to-clean') toast.info(`${pluginName}: niente da pulire`, r.summary)
      else toast.error(`Pulizia di ${pluginName} fallita`, r.summary)
    } catch (e) {
      toast.error('Quick Auto Clean fallito', (e as Error).message)
    } finally {
      setQacBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-dark-800 bg-dark-900/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Link2 size={16} className="text-soul-300" />
          <span className="text-sm font-bold text-dark-100" style={{ fontFamily: 'Cinzel, serif' }}>
            Deployment · Hardlink Engine
          </span>
        </div>
        <div className="flex items-center gap-2">
          {registerApi && (
            <button
              onClick={runRegister}
              disabled={busy != null || profileId == null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
              title="Registra le mod già estratte nello StockGame come installate (le rende visibili al Deploy)"
            >
              {busy === 'register' ? <Loader size={12} className="animate-spin" /> : <FolderSync size={12} />}{' '}
              Registra estratte
            </button>
          )}
          {api.verify && (
            <button
              onClick={runVerify}
              disabled={busy != null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
              title="Confronta il manifest del deploy col disco: file cancellati o sostituiti da tool esterni emergono qui"
            >
              {busy === 'verify' ? <Loader size={12} className="animate-spin" /> : <ShieldCheck size={12} />}{' '}
              Verifica
            </button>
          )}
          <button
            onClick={runPurge}
            disabled={busy != null || profileId == null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
            title="Rimuovi tutti i link creati dal deploy (manifest-based) e ripristina il plugins.txt originale"
          >
            {busy === 'purge' ? <Loader size={12} className="animate-spin" /> : <Trash2 size={12} />} Purge
          </button>
          <button
            onClick={runDeploy}
            disabled={busy != null || profileId == null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs btn-primary disabled:opacity-50"
            title="Collega le mod abilitate nell’istanza e genera il load order dipendenze-consapevole"
          >
            {busy === 'deploy' ? <Loader size={12} className="animate-spin" /> : <Link2 size={12} />} Deploy
          </button>
        </div>
      </div>
      <p className="text-xs text-dark-400 leading-relaxed">
        Collega le mod abilitate (hardlink + junction, zero copie) nella Data dell’istanza in ordine di
        priorità, risolve i conflitti file e genera <code className="text-dark-300">plugins.txt</code>{' '}
        ordinato sul grafo delle dipendenze (master prima; un ciclo blocca il deploy). Il purge usa il
        manifest per rimuovere solo ciò che è stato creato.
      </p>
      {busy === 'deploy' && progress && (
        <div className="mt-2 text-xs text-soul-300 flex items-center gap-2">
          <Loader size={11} className="animate-spin shrink-0" />
          {STAGE_LABEL[progress.stage] ?? progress.stage}
          {progress.percent != null && ` · ${progress.percent}%`}
          {progress.detail && <span className="text-dark-400 truncate max-w-[24rem]">{progress.detail}</span>}
        </div>
      )}
      {summary && !busy && <div className="mt-2 text-xs text-green-300/90">{summary}</div>}
      {dirtyPlugins.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {dirtyPlugins.map((d) => (
            <div key={d.plugin} className="flex items-center justify-between gap-2 rounded-lg bg-red-900/15 border border-red-900/40 px-3 py-1.5 text-xs">
              <span className="text-red-300 truncate">
                {d.plugin} — {d.itm} ITM, {d.udr} UDR{d.nav ? `, ${d.nav} navmesh` : ''}
              </span>
              <button
                onClick={() => runQacClean(d.plugin)}
                disabled={qacBusy != null}
                className="flex items-center gap-1 px-2 py-1 rounded bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50 flex-shrink-0"
                title="Quick Auto Clean headless via SSEEdit (il gioco deve essere chiuso)"
              >
                {qacBusy === d.plugin ? <Loader size={11} className="animate-spin" /> : <Wrench size={11} />} Pulisci
              </button>
            </div>
          ))}
          {Object.entries(qacResults).map(([name, msg]) => (
            <p key={name} className="text-[11px] text-dark-400 pl-1">
              {name}: {msg}
            </p>
          ))}
        </div>
      )}
      {driftItems.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {driftItems.map((item) => (
            <div
              key={item.rel}
              className="flex items-center justify-between gap-2 rounded-lg bg-amber-900/15 border border-amber-900/40 px-3 py-1.5 text-xs"
            >
              <span className="text-amber-300 truncate" title={item.rel}>
                {item.label}
              </span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {item.kind === 'file' && (
                  <button
                    onClick={() => runResolveDrift(item, 'restore')}
                    disabled={driftBusy != null || !api.resolveDrift}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
                    title="Ricollega il nostro file gestito (vincitore ricalcolato ora)"
                  >
                    {driftBusy === item.rel ? <Loader size={11} className="animate-spin" /> : <Link2 size={11} />} Ripristina
                  </button>
                )}
                <button
                  onClick={() => runResolveDrift(item, 'accept')}
                  disabled={driftBusy != null || !api.resolveDrift}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
                  title="Riconosci lo stato esterno come intenzionale: non verrà più segnalato"
                >
                  {driftBusy === item.rel ? <Loader size={11} className="animate-spin" /> : <ShieldCheck size={11} />} Accetta
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
