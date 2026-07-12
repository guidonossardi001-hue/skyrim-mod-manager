import { useEffect, useRef, useState } from 'react'
import { Link2, Trash2, Loader } from 'lucide-react'
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
  const [busy, setBusy] = useState<'deploy' | 'purge' | null>(null)
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
      } else if (r.errorKind === 'dependency-cycle') {
        onLog(`Deploy bloccato: ${r.error}`, 'error')
        toast.error('Ciclo di dipendenze nei plugin', r.error ?? 'deploy bloccato per sicurezza')
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
