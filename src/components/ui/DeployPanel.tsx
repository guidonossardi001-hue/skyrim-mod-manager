import { useEffect, useRef, useState } from 'react'
import { Link2, Trash2, Loader, FolderSync, ShieldCheck } from 'lucide-react'
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
  }
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
        if (r.dirtyPlugins?.length) {
          const names = r.dirtyPlugins.map((d) => `${d.plugin} (${d.itm} ITM, ${d.udr} UDR)`).join(', ')
          onLog(`Plugin da pulire con SSEEdit: ${names}`, 'error')
          toast.warning(`${r.dirtyPlugins.length} plugin da pulire`, names)
        }
      } else if (r.errorKind === 'dependency-cycle') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.error('Ciclo di dipendenze nei plugin', r.error ?? 'deploy bloccato per sicurezza')
      } else if (r.errorKind === 'missing-master') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.error('Master mancanti', r.error ?? 'un plugin richiede master non installati')
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
        const line = `Verifica deploy: ${parts.join(' · ')} — riesegui il Deploy per ripristinare`
        setSummary(null)
        onLog(line, 'warn')
        toast.error('Deploy alterato esternamente', parts.join(' · '))
      }
    } catch (e) {
      toast.error('Verifica fallita', (e as Error).message)
    } finally {
      setBusy(null)
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
    </div>
  )
}
