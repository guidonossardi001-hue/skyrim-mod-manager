import { useState, useRef } from 'react'
import {
  Play,
  ExternalLink,
  Info,
  Wrench,
  Zap,
  Shield,
  Globe,
  Download,
  Upload,
  FileCode,
  Copy,
  Check,
  Palette,
  RefreshCw,
  Database,
  Activity,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { clsx } from 'clsx'
import { toast } from '@/components/ui/Toast'
import type { VortexScanResult } from '@/types'

const MOCK_ENB_PRESETS = [
  { name: 'Rudy ENB - Cathedral', author: 'Rudy102', active: true, performance: 'Pesante' },
  { name: 'Pi-Cho ENB', author: 'Pi-Cho', active: false, performance: 'Medio' },
  { name: 'Serio ENB', author: 'prod80', active: false, performance: 'Leggero' },
  { name: 'Ljoss ENB', author: 'wankingSkeever', active: false, performance: 'Leggero' },
  { name: 'Cabbage ENB', author: 'Cabbage', active: false, performance: 'Pesante' },
]

export default function Tools() {
  const { settings, exportLoadOrder, importFromMO2, checkAllUpdates, mods } = useAppStore()
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { success: boolean; message?: string }>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [enbPresets, setEnbPresets] = useState(MOCK_ENB_PRESETS)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateResult, setUpdateResult] = useState<{ checked: number; updates: number } | null>(null)
  const mo2ImportRef = useRef<HTMLInputElement>(null)

  // Vortex importer (read-only scan; catalog build + Pandora are explicit one-click steps)
  const [vortexScan, setVortexScan] = useState<VortexScanResult | null>(null)
  const [vortexBusy, setVortexBusy] = useState<'scan' | 'catalog' | 'pandora' | null>(null)

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
    {
      id: 'mo2',
      name: 'Mod Organizer 2',
      desc: 'Gestione mod con profili virtuali',
      color: '#7d4dff',
      icon: Shield,
      launch: () =>
        runTool('mo2', () =>
          settings.mo2Path
            ? window.api.tools.launchMO2()
            : Promise.resolve({ success: false, error: 'Percorso MO2 non configurato' }),
        ),
    },
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

      {/* ENB Preset Manager */}
      <div className="card p-5">
        <h3 className="font-semibold text-white/80 mb-4 flex items-center gap-2 text-sm">
          <Palette size={15} className="text-void-400" /> ENB Preset Manager
        </h3>
        <div className="space-y-2">
          {enbPresets.map((preset) => (
            <div
              key={preset.name}
              className={clsx(
                'flex items-center gap-3 p-2.5 rounded-lg border transition-all',
                preset.active ? 'border-void-700/60 bg-void-900/20' : 'border-dark-800 hover:border-dark-600',
              )}
            >
              <div
                className={clsx(
                  'w-2 h-2 rounded-full flex-shrink-0',
                  preset.active ? 'bg-green-400' : 'bg-dark-600',
                )}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white/85 font-medium">{preset.name}</p>
                <p className="text-xs text-dark-400">
                  di {preset.author} · {preset.performance}
                </p>
              </div>
              <span
                className={clsx(
                  'text-xs px-2 py-0.5 rounded-full',
                  preset.performance === 'Pesante'
                    ? 'bg-red-900/30 text-red-400'
                    : preset.performance === 'Medio'
                      ? 'bg-orange-900/30 text-orange-400'
                      : 'bg-green-900/30 text-green-400',
                )}
              >
                {preset.performance}
              </span>
              {!preset.active && (
                <button
                  onClick={() => {
                    setEnbPresets((prev) => prev.map((p) => ({ ...p, active: p.name === preset.name })))
                    toast.success('Preset ENB attivato', preset.name)
                  }}
                  className="text-xs px-2.5 py-1 rounded-lg bg-void-900/40 text-void-300 hover:bg-void-800/60 transition-all"
                >
                  Attiva
                </button>
              )}
              {preset.active && <span className="text-xs text-void-400 font-semibold">ATTIVO</span>}
            </div>
          ))}
        </div>
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
            { n: 6, text: 'Avvia il gioco tramite Mod Organizer 2', color: '#ff4500' },
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
