import { useState, useRef, useEffect } from 'react'
import {
  Play,
  ExternalLink,
  Info,
  Wrench,
  Zap,
  Globe,
  Download,
  Upload,
  FileCode,
  Copy,
  Check,
  RefreshCw,
  Database,
  Activity,
  AlertTriangle,
  Palette,
  X,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { clsx } from 'clsx'
import { toast } from '@/lib/toast'
import type { VortexScanResult } from '@/types'

export default function Tools() {
  const { settings, exportLoadOrder, importFromMO2, checkAllUpdates, mods } = useAppStore()
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { success: boolean; message?: string }>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateResult, setUpdateResult] = useState<{ checked: number; updates: number } | null>(null)
  const mo2ImportRef = useRef<HTMLInputElement>(null)

  // Vortex importer (read-only scan; catalog build + Pandora are explicit one-click steps)
  const [vortexScan, setVortexScan] = useState<VortexScanResult | null>(null)
  const [vortexBusy, setVortexBusy] = useState<'scan' | 'catalog' | 'pandora' | null>(null)

  // Masterlist LOOT reale: la status legge SOLO la cache locale (mai la rete) — sicuro da
  // chiamare al mount. Il refresh è invece sempre un'azione esplicita dell'utente.
  const [masterlistStatus, setMasterlistStatus] = useState<{
    ok: boolean
    cached: boolean
    pluginCount?: number
    groupCount?: number
    ruleCount?: number
    dirtyCount?: number
    fetchedAt?: string
  } | null>(null)
  const [masterlistRefreshing, setMasterlistRefreshing] = useState(false)

  useEffect(() => {
    window.api.masterlist.status().then(setMasterlistStatus)
  }, [])

  // Analizzatore crash log: sola lettura, nessuna azione sul gioco.
  const [crashEntries, setCrashEntries] = useState<{ name: string; path: string; mtimeMs: number; size: number }[]>([])
  const [crashDir, setCrashDir] = useState<string>('')
  const [crashBusy, setCrashBusy] = useState(false)
  const [crashResult, setCrashResult] = useState<Awaited<ReturnType<typeof window.api.crash.analyze>> | null>(null)

  useEffect(() => {
    window.api.crash.listRecent().then((r) => {
      if (r.ok) {
        setCrashEntries(r.entries ?? [])
        setCrashDir(r.dir ?? '')
      }
    })
  }, [])

  const analyzeCrash = async (path: string) => {
    setCrashBusy(true)
    setCrashResult(null)
    try {
      const res = await window.api.crash.analyze(path)
      setCrashResult(res)
      if (!res.ok) toast.error('Analisi crash log fallita', res.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Analisi crash log fallita', (e as Error).message)
    } finally {
      setCrashBusy(false)
    }
  }

  const pickAndAnalyzeCrash = async () => {
    const path = await window.api.fs.pickFile('Seleziona crash log', [{ name: 'Log', extensions: ['log', 'txt'] }])
    if (path) await analyzeCrash(path)
  }

  // Installer FOMOD headless (motore Vortex) + scelte del curatore della collection.
  const [fomodStatus, setFomodStatus] = useState<{
    total?: number
    applied?: number
    withChoices?: number
    choicesCached?: boolean
  } | null>(null)
  const [fomodBusy, setFomodBusy] = useState<'fetch' | 'apply' | null>(null)
  const [fomodProgress, setFomodProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [fomodReport, setFomodReport] = useState<Awaited<ReturnType<typeof window.api.fomod.applyAll>> | null>(null)

  const refreshFomod = async () => {
    const r = await window.api.fomod.scan()
    if (r.ok) setFomodStatus(r)
  }
  useEffect(() => {
    refreshFomod()
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => unknown
      off?: (ch: string, cb: unknown) => void
    }
    if (!api.on) return
    const onP = (p?: { done: number; total: number; current: string }) => p && setFomodProgress(p)
    const w = api.on('fomod:progress', onP as (...a: unknown[]) => void)
    return () => api.off?.('fomod:progress', w)
  }, [])

  const fetchFomodChoices = async () => {
    setFomodBusy('fetch')
    try {
      const r = await window.api.fomod.fetchChoices()
      if (r.ok) {
        toast.success('Scelte del curatore scaricate', `${r.withChoices} mod con scelte FOMOD su ${r.mods} nel manifest`)
        await refreshFomod()
      } else toast.error('Download scelte fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Download scelte fallito', (e as Error).message)
    } finally {
      setFomodBusy(null)
    }
  }

  const applyFomodAll = async () => {
    if (
      !window.confirm(
        'Applicare gli installer FOMOD a tutte le mod estratte?\n\nLe cartelle mod verranno ristrutturate nel layout finale (le varianti NON scelte vengono rimosse: un re-install richiede il re-download). Le scelte del curatore vengono usate dove disponibili, altrimenti i default dell\'autore.',
      )
    )
      return
    setFomodBusy('apply')
    setFomodReport(null)
    try {
      const r = await window.api.fomod.applyAll()
      setFomodReport(r)
      if (r.ok)
        toast.success(
          'FOMOD applicati',
          `${r.applied}/${r.processed} mod ristrutturate · ${r.defaultsUsed} coi default autore · ${r.failed?.length ?? 0} fallite`,
        )
      else toast.error('Applicazione FOMOD fallita', r.error ?? 'errore sconosciuto')
      await refreshFomod()
    } catch (e) {
      toast.error('Applicazione FOMOD fallita', (e as Error).message)
    } finally {
      setFomodBusy(null)
      setFomodProgress(null)
    }
  }

  // BodySlide batch build headless: corpi, fisiche e outfit adattati al preset del curatore.
  const [bsStatus, setBsStatus] = useState<Awaited<ReturnType<typeof window.api.bodyslide.status>> | null>(null)
  const [bsPreset, setBsPreset] = useState<string>('')
  const [bsBusy, setBsBusy] = useState(false)
  const [bsProgress, setBsProgress] = useState<{ pass: number; passes: number; chunk: number; chunks: number; label: string } | null>(null)
  const [bsReport, setBsReport] = useState<Awaited<ReturnType<typeof window.api.bodyslide.build>> | null>(null)

  const refreshBodySlide = async () => {
    const s = await window.api.bodyslide.status()
    setBsStatus(s)
    if (s.ok && s.defaultPreset) setBsPreset((prev) => prev || s.defaultPreset!)
  }
  useEffect(() => {
    refreshBodySlide()
    const api = window.api as unknown as {
      on?: (ch: string, cb: (...a: unknown[]) => void) => unknown
      off?: (ch: string, cb: unknown) => void
    }
    if (!api.on) return
    const onP = (p?: { pass: number; passes: number; chunk: number; chunks: number; label: string }) => p && setBsProgress(p)
    const w = api.on('bodyslide:progress', onP as (...a: unknown[]) => void)
    return () => api.off?.('bodyslide:progress', w)
  }, [])

  const runBodySlideBuild = async () => {
    const profileId = useAppStore.getState().activeProfileId
    if (!profileId) {
      toast.warning('Nessun profilo attivo', 'Seleziona un profilo prima del build')
      return
    }
    if (
      !window.confirm(
        `Batch build BodySlide col preset "${bsPreset || bsStatus?.defaultPreset || ''}"?\n\nCostruisce corpi e TUTTI gli outfit della collection (può richiedere parecchi minuti). L'output va nella mod "BodySlide Output (generato)": al termine riesegui il Deploy per portarlo nel gioco.`,
      )
    )
      return
    setBsBusy(true)
    setBsReport(null)
    try {
      const r = await window.api.bodyslide.build(profileId, bsPreset || undefined)
      setBsReport(r)
      if (r.ok)
        toast.success('Batch build completato', `${r.filesBuilt} file generati · riesegui il Deploy per applicarli`)
      else toast.error('Batch build fallito', r.error ?? 'errore sconosciuto')
      await refreshBodySlide()
    } catch (e) {
      toast.error('Batch build fallito', (e as Error).message)
    } finally {
      setBsBusy(false)
      setBsProgress(null)
    }
  }

  // Preset ENB REALI: scan nelle mod estratte, apply nella root del gioco (backup+manifest).
  const [enbPresets, setEnbPresets] = useState<
    { modName: string; presetDir: string; label: string; files: number; hasCoreDll: boolean }[] | null
  >(null)
  const [enbBusy, setEnbBusy] = useState<'scan' | 'apply' | 'remove' | null>(null)

  const scanEnb = async () => {
    setEnbBusy('scan')
    try {
      const r = await window.api.enb.scan()
      setEnbPresets(r.presets)
      if (!r.presets.length) toast.info('Nessun preset ENB', 'Nessuna mod estratta contiene enbseries.ini/enblocal.ini')
      else toast.success(`${r.presets.length} preset ENB trovati`, 'Scegli quale applicare alla root del gioco')
    } catch (e) {
      toast.error('Scan ENB fallito', (e as Error).message)
    } finally {
      setEnbBusy(null)
    }
  }

  const applyEnb = async (presetDir: string, label: string) => {
    if (
      !window.confirm(
        `Applicare il preset ENB "${label}" alla root del gioco?\n\nGli originali preesistenti vengono salvati (.smm-enb-bak) e "Rimuovi preset ENB" ripristina tutto.`,
      )
    )
      return
    setEnbBusy('apply')
    try {
      const r = await window.api.enb.apply(presetDir, label)
      if (r.ok) {
        toast.success(
          'Preset ENB applicato',
          `${r.applied} file nella root del gioco · ${r.backedUp} originali salvati${r.removedPrevious ? ' · preset precedente rimosso' : ''}`,
        )
        if (!r.coreDllPresent)
          toast.warning(
            'Core ENB assente (d3d11.dll)',
            'Il preset non ha effetto senza il core: scaricalo da enbdev.com e metti d3d11.dll + d3dcompiler_46e.dll nella cartella del gioco',
          )
      } else toast.error('Apply ENB fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Apply ENB fallito', (e as Error).message)
    } finally {
      setEnbBusy(null)
    }
  }

  const removeEnb = async () => {
    setEnbBusy('remove')
    try {
      const r = await window.api.enb.remove()
      if (r.ok) toast.success('Preset ENB rimosso', `${r.removed} file rimossi · ${r.restored} originali ripristinati`)
      else toast.error('Rimozione ENB fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Rimozione ENB fallita', (e as Error).message)
    } finally {
      setEnbBusy(null)
    }
  }

  const refreshMasterlist = async () => {
    setMasterlistRefreshing(true)
    try {
      const res = await window.api.masterlist.refresh()
      if (res.ok) {
        setMasterlistStatus({ ...res, cached: true })
        toast.success(
          'Masterlist LOOT aggiornato',
          `${res.pluginCount ?? 0} plugin · ${res.ruleCount ?? 0} regole · ${res.dirtyCount ?? 0} entry dirty`,
        )
      } else {
        toast.error('Aggiornamento masterlist fallito', res.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Aggiornamento masterlist fallito', (e as Error).message)
    } finally {
      setMasterlistRefreshing(false)
    }
  }

  const runVortexScan = async () => {
    setVortexBusy('scan')
    try {
      const res = await window.api.vortex.scan()
      setVortexScan(res)
      toast.success(
        `Vortex: ${res.mods.length} mod uniche`,
        `${res.collections.length} collezioni · ${res.duplicatesRemoved} doppioni rimossi`,
      )
    } catch (e) {
      toast.error('Scansione Vortex fallita', (e as Error).message)
    } finally {
      setVortexBusy(null)
    }
  }
  const buildVortexCatalog = async () => {
    setVortexBusy('catalog')
    try {
      const r = await window.api.vortex.buildCatalog()
      toast.success('catalog.json generato', `${r.total} mod → ${r.path}`)
    } catch (e) {
      toast.error('Generazione catalogo fallita', (e as Error).message)
    } finally {
      setVortexBusy(null)
    }
  }
  const runPandora = async () => {
    if (!settings.pandoraPath) {
      toast.warning('Pandora non configurato', 'Imposta il percorso in Impostazioni')
      return
    }
    if (!window.confirm('Pandora rigenererà i file di comportamento (behaviour) del gioco. Continuare?'))
      return
    setVortexBusy('pandora')
    try {
      const r = await window.api.tools.launchPandora()
      if (r.success) toast.success('Pandora avviato', 'Rigenerazione behaviour in corso')
      else toast.error('Pandora non avviato', r.error)
    } catch (e) {
      toast.error('Errore Pandora', (e as Error).message)
    } finally {
      setVortexBusy(null)
    }
  }

  const runTool = async (id: string, fn: () => Promise<{ success: boolean; error?: string }>) => {
    setRunning(id)
    try {
      const result = await fn()
      setResults((r) => ({ ...r, [id]: { success: result.success, message: result.error } }))
      if (result.success) toast.success(`${id.toUpperCase()} avviato`)
      else toast.error(`Errore ${id}`, result.error)
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { success: false, message: String(e) } }))
    } finally {
      setRunning(null)
    }
  }

  const handleExport = (type: 'plugins' | 'modlist') => {
    const { pluginsTxt, modlistTxt } = exportLoadOrder()
    const text = type === 'plugins' ? pluginsTxt : modlistTxt
    const filename = type === 'plugins' ? 'plugins.txt' : 'modlist.txt'
    navigator.clipboard.writeText(text)
    setCopied(type)
    setTimeout(() => setCopied(null), 2000)
    toast.success(`${filename} copiato`, `${text.split('\n').length} righe negli appunti`)
  }

  const handleDownloadExport = (type: 'plugins' | 'modlist') => {
    const { pluginsTxt, modlistTxt } = exportLoadOrder()
    const text = type === 'plugins' ? pluginsTxt : modlistTxt
    const filename = type === 'plugins' ? 'plugins.txt' : 'modlist.txt'
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`${filename} scaricato`)
  }

  const handleMO2Import = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const result = await importFromMO2(text)
    toast.success('Import completato', `${result.imported} mod importate da MO2`)
    e.target.value = ''
  }

  const handleCheckAllUpdates = async () => {
    // The delta engine compares the installed snapshot against the latest ingested
    // manifest and needs no Nexus key; the key only matters for the legacy fallback.
    setCheckingUpdates(true)
    setUpdateResult(null)
    try {
      const result = await checkAllUpdates()
      setUpdateResult(result)
      if (result.updates > 0)
        toast.warning(`${result.updates} aggiornamenti disponibili`, `Controllate ${result.checked} mod`)
      else toast.success('Tutto aggiornato', `Controllate ${result.checked} mod`)
    } finally {
      setCheckingUpdates(false)
    }
  }

  // I percorsi degli exe sono risolti dal MAIN (settings store): il renderer chiede
  // solo QUALE tool avviare. Il check sul path serve unicamente per l'UX del messaggio.
  const TOOLS = [
    // NB: nessuna tile per Mod Organizer 2 — questo launcher È il mod manager (deploy
    // hardlink + plugins.txt di sistema + avvio via SKSE interno). Il percorso MO2 non è
    // nemmeno impostabile: la tile falliva sempre con "Percorso MO2 non configurato".
    {
      id: 'loot',
      name: 'LOOT',
      desc: 'Ordina automaticamente i plugin',
      color: '#4d7dff',
      icon: Zap,
      launch: () =>
        runTool('loot', () =>
          settings.lootPath
            ? window.api.tools.launchLOOT()
            : Promise.resolve({ success: false, error: 'Configura i percorsi nelle Impostazioni' }),
        ),
    },
    {
      id: 'sseedit',
      name: 'SSEEdit / xEdit',
      desc: 'Editor plugin .esp/.esm avanzato',
      color: '#ff6a2e',
      icon: Wrench,
      launch: () =>
        runTool('sseedit', () =>
          settings.sseeditPath
            ? window.api.tools.launchSSEEdit()
            : Promise.resolve({ success: false, error: 'Percorso SSEEdit non configurato' }),
        ),
    },
    {
      id: 'dyndolod',
      name: 'DynDOLOD',
      desc: 'LOD dinamici per alberi e distanze',
      color: '#4de0ff',
      icon: Globe,
      launch: () =>
        runTool('dyndolod', () =>
          settings.dyndolodPath
            ? window.api.tools.launchDynDOLOD()
            : Promise.resolve({ success: false, error: 'Percorso DynDOLOD non configurato' }),
        ),
    },
    {
      id: 'pandora',
      name: 'Pandora Behaviour',
      desc: 'Framework animazioni per MCO',
      color: '#ff80cc',
      icon: Zap,
      launch: () =>
        runTool('pandora', () =>
          settings.pandoraPath
            ? window.api.tools.launchPandora()
            : Promise.resolve({ success: false, error: 'Percorso Pandora non configurato' }),
        ),
    },
    {
      id: 'xlodgen',
      name: 'xLODGen',
      desc: 'LOD per terreni e oggetti statici',
      color: '#4dffaa',
      icon: Globe,
      url: 'https://stepmodifications.org/forum/topic/13451-xlodgen-terrain-lod-beta/',
    },
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h1 className="text-lg font-bold gradient-text-dragon" style={{ fontFamily: 'Cinzel, serif' }}>
        Strumenti Esterni
      </h1>

      {/* External tools grid */}
      <div className="grid grid-cols-2 gap-4">
        {TOOLS.map((tool) => {
          const Icon = tool.icon
          const result = results[tool.id]
          const isRunning = running === tool.id
          return (
            <div key={tool.id} className="card p-4 flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: `${tool.color}22` }}
                >
                  <Icon size={18} style={{ color: tool.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-white/90 text-sm">{tool.name}</h3>
                  <p className="text-xs text-dark-400 mt-0.5">{tool.desc}</p>
                </div>
              </div>
              {result && (
                <div
                  className={clsx(
                    'text-xs px-2 py-1 rounded',
                    result.success ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400',
                  )}
                >
                  {result.success ? '✓ Avviato' : `✗ ${result.message ?? 'Errore'}`}
                </div>
              )}
              <div className="flex gap-2 mt-auto">
                {tool.launch && (
                  <button
                    onClick={tool.launch}
                    disabled={isRunning}
                    className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                    style={{ borderColor: tool.color + '44' }}
                  >
                    <Play size={12} style={{ color: tool.color }} />
                    {isRunning ? 'Avvio...' : 'Avvia'}
                  </button>
                )}
                {tool.url && (
                  <button
                    onClick={() => window.api.fs.openExternal(tool.url!)}
                    className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                  >
                    <ExternalLink size={12} /> Download
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Export Load Order */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <FileCode size={15} className="text-soul-400" /> Export Load Order
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Esporta il load order in formato compatibile con MO2 e LOOT ({mods.length} mod).
        </p>
        <div className="grid grid-cols-2 gap-3">
          {(['plugins', 'modlist'] as const).map((type) => (
            <div key={type} className="space-y-2">
              <p className="text-xs font-semibold text-dark-300">
                {type === 'plugins' ? 'plugins.txt' : 'modlist.txt'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleExport(type)}
                  className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                >
                  {copied === type ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  {copied === type ? 'Copiato!' : 'Copia'}
                </button>
                <button
                  onClick={() => handleDownloadExport(type)}
                  className="btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
                >
                  <Download size={12} /> Scarica
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Installer FOMOD headless (motore ufficiale Vortex): le mod estratte flat con
          ModuleConfig.xml vengono ristrutturate nel layout finale usando le SCELTE del
          curatore della collection (o i default dell'autore dove mancano). */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Wrench size={15} className="text-soul-400" /> Installer FOMOD (scelte collection)
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Le mod con installer FOMOD estratte "piatte" hanno gli asset dentro cartelle-opzione che il
          gioco ignora. Qui vengono ristrutturate col motore di Vortex: prima scarica le scelte del
          curatore, poi applica a tutte.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={fetchFomodChoices}
            disabled={fomodBusy !== null}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <Download size={14} className={fomodBusy === 'fetch' ? 'animate-pulse' : ''} />
            {fomodBusy === 'fetch' ? 'Download…' : 'Scarica scelte del curatore'}
          </button>
          <button
            onClick={applyFomodAll}
            disabled={fomodBusy !== null || !fomodStatus?.total}
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg btn-primary disabled:opacity-50"
          >
            <Zap size={14} className={fomodBusy === 'apply' ? 'animate-pulse' : ''} />
            {fomodBusy === 'apply' ? 'Applicazione…' : `Applica a tutte (${(fomodStatus?.total ?? 0) - (fomodStatus?.applied ?? 0)})`}
          </button>
        </div>
        {fomodStatus && (
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-dark-300">
            <span>{fomodStatus.total ?? 0} mod con FOMOD</span>
            <span>·</span>
            <span className="text-green-400">{fomodStatus.applied ?? 0} già applicate</span>
            <span>·</span>
            <span>{fomodStatus.choicesCached ? `${fomodStatus.withChoices ?? 0} con scelte del curatore` : 'scelte del curatore NON ancora scaricate'}</span>
          </div>
        )}
        {fomodProgress && fomodBusy === 'apply' && (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-dark-400 mb-1">
              <span className="truncate">{fomodProgress.current}</span>
              <span className="font-mono">{fomodProgress.done}/{fomodProgress.total}</span>
            </div>
            <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
              <div
                className="progress-shimmer h-full rounded-full transition-all"
                style={{ width: fomodProgress.total ? `${(fomodProgress.done / fomodProgress.total) * 100}%` : '0%' }}
              />
            </div>
          </div>
        )}
        {fomodReport?.ok && ((fomodReport.failed?.length ?? 0) > 0 || (fomodReport.unsupported?.length ?? 0) > 0) && (
          <div className="mt-3 space-y-1 text-xs max-h-40 overflow-y-auto">
            {fomodReport.unsupported?.map((m) => (
              <p key={m} className="text-orange-300">
                {m}: installer non-XML (richiede intervento manuale)
              </p>
            ))}
            {fomodReport.failed?.map((f) => (
              <p key={f.mod} className="text-red-300">
                {f.mod}: {f.error}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* BodySlide batch build headless: corpi (CBBE/3BA), fisiche (pesi SMP/CBPC nei mesh) e
          TUTTI gli outfit adattati al preset — l'output è una mod generata che vince i
          conflitti al Deploy successivo (mai scritture in-place negli hardlink di Data). */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Activity size={15} className="text-pink-400" /> BodySlide — corpi, fisiche e outfit
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Costruisce i corpi e adatta armature/vestiti della collection al preset scelto (batch build
          headless con morph <code className="text-void-400">.tri</code> per RaceMenu/OStim). Richiede il
          Deploy già eseguito; al termine <b>riesegui il Deploy</b> per portare i mesh generati nel gioco.
        </p>

        {bsStatus && !bsStatus.ok && <p className="text-xs text-red-400 mb-3">{bsStatus.error}</p>}
        {bsStatus?.ok && (
          <>
            <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
              <span className={clsx('px-2 py-1 rounded-lg border', bsStatus.exeFound ? 'border-green-900/50 bg-green-900/20 text-green-400' : 'border-red-900/50 bg-red-900/20 text-red-300')}>
                {bsStatus.exeFound ? 'BodySlide deployato' : 'BodySlide non deployato'}
              </span>
              <span className={clsx('px-2 py-1 rounded-lg border', bsStatus.deployed ? 'border-green-900/50 bg-green-900/20 text-green-400' : 'border-orange-900/50 bg-orange-900/20 text-orange-300')}>
                {bsStatus.deployed ? 'Deploy attivo' : 'Deploy assente'}
              </span>
              {([['Corpo CBBE/3BA', bsStatus.prereqs.body], ['CBPC', bsStatus.prereqs.cbpc], ['FSMP (HDT-SMP)', bsStatus.prereqs.fsmp], ['Scheletro XP32', bsStatus.prereqs.skeleton]] as const).map(
                ([label, ok]) => (
                  <span
                    key={label}
                    className={clsx('px-2 py-1 rounded-lg border', ok ? 'border-green-900/50 bg-green-900/20 text-green-400' : 'border-orange-900/50 bg-orange-900/20 text-orange-300')}
                    title={ok ? 'Presente e abilitata' : 'Mod non trovata tra le abilitate'}
                  >
                    {ok ? '✓' : '!'} {label}
                  </span>
                ),
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <Stat label="Progetti (.osp)" value={bsStatus.setsCount} />
              <Stat label="Gruppi outfit" value={bsStatus.groupCount} />
              <Stat label="Preset" value={bsStatus.presets.length} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={bsPreset}
                onChange={(e) => setBsPreset(e.target.value)}
                disabled={bsBusy || !bsStatus.presets.length}
                className="input-field text-xs py-1.5 max-w-xs"
                title="Preset corpo per il pass principale (il pass HIMBO usa il suo preset dedicato)"
              >
                {bsStatus.presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} — copre {p.coverage} gruppi
                  </option>
                ))}
              </select>
              <button
                onClick={runBodySlideBuild}
                disabled={bsBusy || !bsStatus.exeFound || !bsStatus.deployed}
                className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg btn-primary disabled:opacity-50"
              >
                <Zap size={14} className={bsBusy ? 'animate-pulse' : ''} />
                {bsBusy ? 'Build in corso…' : 'Batch build corpi + outfit'}
              </button>
            </div>
            {bsProgress && bsBusy && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-dark-400 mb-1">
                  <span className="truncate">{bsProgress.label}</span>
                  <span className="font-mono">
                    pass {bsProgress.pass}/{bsProgress.passes} · lotto {bsProgress.chunk}/{bsProgress.chunks}
                  </span>
                </div>
                <div className="h-1.5 bg-dark-700 rounded-full overflow-hidden">
                  <div
                    className="progress-shimmer h-full rounded-full transition-all"
                    style={{
                      width: `${((bsProgress.pass - 1 + bsProgress.chunk / Math.max(1, bsProgress.chunks)) / Math.max(1, bsProgress.passes)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {bsReport && (
              <div className="mt-3 space-y-1 text-xs">
                {bsReport.passes.map((p) => (
                  <p key={p.label} className={p.failedChunks ? 'text-orange-300' : 'text-dark-300'}>
                    {p.label}: preset <span className="text-white/85">{p.preset}</span> · {p.groups} gruppi ·{' '}
                    {p.chunks - p.failedChunks}/{p.chunks} lotti ok
                  </p>
                ))}
                {bsReport.ok && (
                  <p className="text-green-400">
                    {bsReport.filesBuilt} file generati in "BodySlide Output (generato)" — riesegui il Deploy per applicarli.
                  </p>
                )}
                {!bsReport.ok && bsReport.error && <p className="text-red-300">{bsReport.error}</p>}
              </div>
            )}
          </>
        )}
      </div>

      {/* Preset ENB REALI (sostituisce il vecchio mock): scan nelle mod estratte, apply nella
          ROOT del gioco con backup+manifest — il deploy non copre i file fuori da Data. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Palette size={15} className="text-void-400" /> Preset ENB
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Cerca i preset ENB dentro le mod estratte e applicali alla <b>root del gioco</b> (enbseries.ini,
          enblocal.ini, cartelle enbseries/). Originali salvati e ripristinabili. Il core ENB
          (d3d11.dll) va scaricato a parte da enbdev.com.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={scanEnb} disabled={enbBusy !== null} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
            <Palette size={14} className={enbBusy === 'scan' ? 'animate-pulse' : ''} />
            {enbBusy === 'scan' ? 'Ricerca…' : 'Cerca preset ENB'}
          </button>
          <button
            onClick={removeEnb}
            disabled={enbBusy !== null}
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-red-950/40 text-red-300 hover:bg-red-900/50 transition-all disabled:opacity-50"
            title="Rimuove il preset applicato e ripristina gli originali dal manifest"
          >
            <X size={14} /> Rimuovi preset ENB
          </button>
        </div>
        {enbPresets && enbPresets.length > 0 && (
          <div className="mt-4 space-y-2">
            {enbPresets.map((p) => (
              <div
                key={p.presetDir}
                className="flex items-center gap-3 p-2.5 rounded-lg border border-dark-800 hover:border-dark-600 transition-all"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/85 font-medium truncate">{p.label}</p>
                  <p className="text-xs text-dark-400">
                    {p.files} file{p.hasCoreDll ? ' · include d3d11.dll' : ''}
                  </p>
                </div>
                <button
                  onClick={() => applyEnb(p.presetDir, p.label)}
                  disabled={enbBusy !== null}
                  className="text-xs px-2.5 py-1 rounded-lg bg-void-900/40 text-void-300 hover:bg-void-800/60 transition-all disabled:opacity-50"
                >
                  Applica
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Check all updates */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <RefreshCw size={15} className="text-green-400" /> Controlla Aggiornamenti
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Verifica via Nexus API se ci sono aggiornamenti per tutte le mod installate. Richiede API Key.
        </p>
        <div className="flex items-center gap-4">
          <button
            onClick={handleCheckAllUpdates}
            disabled={checkingUpdates}
            className="btn-ghost flex items-center gap-2 text-sm"
          >
            <RefreshCw size={14} className={checkingUpdates ? 'animate-spin' : ''} />
            {checkingUpdates ? 'Controllo in corso...' : 'Controlla tutte'}
          </button>
          {updateResult && (
            <div
              className={clsx(
                'text-xs px-3 py-1.5 rounded-lg',
                updateResult.updates > 0
                  ? 'bg-orange-900/30 text-orange-300'
                  : 'bg-green-900/30 text-green-400',
              )}
            >
              {updateResult.updates > 0
                ? `${updateResult.updates} aggiornamenti su ${updateResult.checked} mod`
                : `Tutte le ${updateResult.checked} mod sono aggiornate`}
            </div>
          )}
        </div>
      </div>

      {/* Import from MO2 */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Upload size={15} className="text-orange-400" /> Import da MO2
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Importa una modlist esistente da Mod Organizer 2 (file{' '}
          <code className="text-void-400">modlist.txt</code>).
        </p>
        <input ref={mo2ImportRef} type="file" accept=".txt" onChange={handleMO2Import} className="hidden" />
        <button
          onClick={() => mo2ImportRef.current?.click()}
          className="btn-ghost flex items-center gap-2 text-sm"
        >
          <Upload size={14} /> Seleziona modlist.txt
        </button>
      </div>

      {/* Import from Vortex (read-only scan → catalog → Pandora, one-click & gated) */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Database size={15} className="text-soul-400" /> Import da Vortex (collezioni Nexus)
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Legge la staging folder di Vortex (<code className="text-void-400">…\Vortex\skyrimse\mods</code>),
          estrae modId/fileId dai <code className="text-void-400">collection.json</code>, deduplica e genera
          il catalogo. Solo lettura.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={runVortexScan}
            disabled={vortexBusy !== null}
            className="btn-ghost flex items-center gap-2 text-sm"
          >
            <Database size={14} className={vortexBusy === 'scan' ? 'animate-pulse' : ''} />
            {vortexBusy === 'scan' ? 'Scansione…' : 'Scansiona Vortex'}
          </button>
          <button
            onClick={buildVortexCatalog}
            disabled={vortexBusy !== null || !vortexScan}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-40"
          >
            <Download size={14} /> {vortexBusy === 'catalog' ? 'Generazione…' : 'Genera catalog.json'}
          </button>
          <button
            onClick={runPandora}
            disabled={vortexBusy !== null}
            title="Rigenera i file di comportamento (azione che modifica il gioco)"
            className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-orange-900/30 text-orange-300 hover:bg-orange-900/50 transition-all disabled:opacity-40"
          >
            <Activity size={14} className={vortexBusy === 'pandora' ? 'animate-pulse' : ''} /> Rigenera
            behaviour (Pandora)
          </button>
        </div>

        {vortexScan && (
          <div className="mt-4 text-xs space-y-2">
            <div className="flex flex-wrap gap-2">
              {vortexScan.collections.map((c) => (
                <span
                  key={c}
                  className="px-2 py-1 rounded-lg bg-dark-800/70 border border-dark-700 text-white/80"
                >
                  {c}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Mod uniche" value={vortexScan.mods.length} />
              <Stat label="Doppioni rimossi" value={vortexScan.duplicatesRemoved} />
              <Stat label="Cartelle staging" value={vortexScan.folderCount} />
            </div>
            <p className="text-dark-500">
              {vortexScan.mods.filter((m) => m.fileId != null).length} con fileId ·{' '}
              {vortexScan.mods.filter((m) => m.source === 'folder').length} da nome cartella · base resources:{' '}
              {vortexScan.mods.filter((m) => [17230, 32444, 106097].includes(m.modId)).length}
            </p>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 text-[11px] text-dark-500">
          <Info size={12} className="flex-shrink-0 mt-0.5 text-soul-400" />
          La scansione gira anche automaticamente all'avvio (read-only). Download/estrazione e Pandora restano
          azioni esplicite: l'app non scarica né modifica il gioco senza il tuo consenso.
        </div>
      </div>

      {/* Masterlist LOOT reale: regole after community-curate + rank di gruppo + CRC dirty-plugin,
          usate dal deploy per il load order e per segnalare i plugin da pulire con SSEEdit. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <Zap size={15} className="text-blue-400" /> Masterlist LOOT
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Scarica il masterlist ufficiale (<code className="text-void-400">loot/skyrimse</code>): migliaia di
          regole di ordinamento e firme CRC dei plugin "sporchi" (ITM/UDR). Il deploy le legge SOLO dalla cache
          locale — mai una richiesta di rete durante il deploy stesso.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={refreshMasterlist}
            disabled={masterlistRefreshing}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={masterlistRefreshing ? 'animate-spin' : ''} />
            {masterlistRefreshing ? 'Aggiornamento…' : 'Aggiorna masterlist'}
          </button>
        </div>
        {masterlistStatus?.cached ? (
          <div className="mt-4 grid grid-cols-4 gap-3 text-xs">
            <Stat label="Plugin" value={masterlistStatus.pluginCount ?? 0} />
            <Stat label="Gruppi" value={masterlistStatus.groupCount ?? 0} />
            <Stat label="Regole after" value={masterlistStatus.ruleCount ?? 0} />
            <Stat label="Firme dirty" value={masterlistStatus.dirtyCount ?? 0} />
          </div>
        ) : (
          masterlistStatus && <p className="mt-3 text-xs text-dark-500">Nessuna cache: premi "Aggiorna masterlist".</p>
        )}
        {masterlistStatus?.fetchedAt && (
          <p className="mt-2 text-[11px] text-dark-500">
            Ultimo aggiornamento: {new Date(masterlistStatus.fetchedAt).toLocaleString('it-IT')}
          </p>
        )}
      </div>

      {/* Analizzatore crash log: sola lettura, nessuna azione sul gioco. Euristica piccola e
          onesta (modulo colpevole dalla call stack) — non un database di pattern noti come
          Phostwood's Crash Log Analyzer, sempre affiancata dal report strutturato completo. */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-1 flex items-center gap-2 text-sm">
          <AlertTriangle size={15} className="text-red-400" /> Analizza crash log
        </h3>
        <p className="text-xs text-dark-400 mb-4">
          Legge un crash log (Crash Logger SSE/AE/VR o Trainwreck) e prova a indicare il modulo
          probabilmente coinvolto dalla call stack. Sola lettura: nessuna modifica al gioco.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={pickAndAnalyzeCrash} disabled={crashBusy} className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50">
            <FileCode size={14} /> Sfoglia file…
          </button>
          {crashEntries.length > 0 && (
            <select
              disabled={crashBusy}
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) analyzeCrash(e.target.value)
                e.target.value = ''
              }}
              className="input-field text-xs py-1.5"
            >
              <option value="" disabled>
                Recenti in {crashDir}…
              </option>
              {crashEntries.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.name} — {new Date(c.mtimeMs).toLocaleString('it-IT')}
                </option>
              ))}
            </select>
          )}
        </div>

        {crashBusy && <p className="mt-4 text-xs text-dark-500">Analisi in corso…</p>}

        {crashResult && !crashResult.ok && (
          <p className="mt-4 text-xs text-red-400">{crashResult.error}</p>
        )}

        {crashResult?.ok && crashResult.report && (
          <div className="mt-4 space-y-3 text-xs">
            {!crashResult.report.recognized && (
              <p className="text-orange-400">File non riconosciuto come crash log Skyrim: mostro solo l'estratto grezzo.</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Plugin SKSE" value={crashResult.report.ssePlugins.length} />
              <Stat label="Plugin caricati" value={crashResult.report.plugins.length} />
              <Stat label="Frame call stack" value={crashResult.report.callStack.length} />
            </div>
            {crashResult.report.exceptionType && (
              <p className="text-dark-300">
                Eccezione: <span className="text-white/90">{crashResult.report.exceptionType}</span> in{' '}
                <span className="text-white/90">{crashResult.report.exceptionModule}</span>
                {crashResult.report.gameVersion && <> · {crashResult.report.gameVersion}</>}
              </p>
            )}
            {crashResult.analysis?.suggestions.map((s, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg bg-orange-900/20 border border-orange-900/40 px-3 py-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-orange-400" />
                <span className="text-dark-200">{s}</span>
              </div>
            ))}
            {crashResult.rawExcerpt && (
              <details className="mt-2">
                <summary className="cursor-pointer text-dark-400 hover:text-white/80">Estratto grezzo (prime righe)</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all text-[10px] text-dark-400 bg-dark-900/60 rounded-lg p-3 max-h-64 overflow-y-auto">
                  {crashResult.rawExcerpt}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Workflow guide */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-3 flex items-center gap-2 text-sm">
          <Info size={15} className="text-soul-400" /> Ordine di esecuzione consigliato
        </h3>
        <ol className="space-y-2">
          {[
            { n: 1, text: 'Installa tutte le mod tramite il Catalogo', color: '#7d4dff' },
            { n: 2, text: 'Esegui LOOT per ordinare i plugin', color: '#4d7dff' },
            { n: 3, text: 'Esegui Pandora Behaviour Engine per le animazioni', color: '#ff80cc' },
            { n: 4, text: 'Esegui xLODGen per i LOD del terreno', color: '#4dffaa' },
            { n: 5, text: 'Esegui DynDOLOD per i LOD degli alberi e oggetti', color: '#4de0ff' },
            { n: 6, text: 'Esegui il Deploy dalla Dashboard per collegare le mod al gioco', color: '#ff6a2e' },
            { n: 7, text: 'Batch build BodySlide (corpi/outfit sul preset), poi riesegui il Deploy', color: '#ff80cc' },
            { n: 8, text: 'Premi GIOCA: il launcher avvia Skyrim col suo SKSE interno', color: '#ff4500' },
          ].map(({ n, text, color }) => (
            <li key={n} className="flex items-center gap-3 text-sm text-dark-300">
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: color + '33', color }}
              >
                {n}
              </span>
              {text}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-dark-800/50 border border-dark-700 px-3 py-2">
      <div className="text-lg font-bold text-white">{value}</div>
      <div className="text-[11px] text-dark-400">{label}</div>
    </div>
  )
}
