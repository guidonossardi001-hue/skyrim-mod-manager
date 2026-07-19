import { useState, useMemo, useEffect, useCallback } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useAppStore } from '@/store/appStore'
import {
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  CheckCircle,
  Info,
  Zap,
  ArrowUp,
  PowerOff,
  Layers,
  ArrowLeftRight,
  Pin,
  X,
  ChevronDown,
  ChevronRight,
  Swords,
  Search,
  EyeOff,
  Eye,
  ExternalLink,
} from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from '@/lib/toast'
import type {
  ConflictInfo,
  RecordConflictItem,
  RecordConflictScanProgress,
  RecordConflictStatus,
  RecordConflictSummary,
} from '@/types'

export default function Conflicts() {
  const { conflicts, mods, detectConflicts, resolveConflict, setActivePage, activeProfileId } = useAppStore()

  // ── Sovrascritture REALI dal piano di deploy (dry-run, zero scritture) ──────────────
  // Risoluzione avanzata: niente disattivazione — la mod scelta riceve un resolution_weight
  // superiore e VINCE i file contesi al prossimo deploy (regole categoria/peso/priorità).
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof window.api.deploy.preview>> | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [preferBusy, setPreferBusy] = useState<string | null>(null)
  // Regole conflitto FILE-level (fissano il vincitore per UN percorso esatto, non l'intera mod
  // come "Inverti precedenza" sopra) — vedi electron/deploy/plan.ts FileConflictRule.
  const [rules, setRules] = useState<{ id: number; relPath: string; winnerMod: string }[]>([])
  const [pinBusy, setPinBusy] = useState<string | null>(null)
  const [expandedPair, setExpandedPair] = useState<string | null>(null)

  const runPreview = async () => {
    if (activeProfileId == null) return
    setPreviewBusy(true)
    try {
      const r = await window.api.deploy.preview(activeProfileId)
      setPreview(r)
      if (!r.ok) toast.error('Analisi conflitti fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Analisi conflitti fallita', (e as Error).message)
    } finally {
      setPreviewBusy(false)
    }
  }

  const loadRules = useCallback(async () => {
    if (activeProfileId == null || !window.api.deploy.conflictRules) return
    try {
      const r = await window.api.deploy.conflictRules.list(activeProfileId)
      if (Array.isArray(r)) setRules(r)
    } catch {
      /* la lista regole resta quella precedente: non è critico */
    }
  }, [activeProfileId])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const pinFile = async (relPath: string, winnerMod: string) => {
    if (activeProfileId == null || pinBusy || !window.api.deploy.conflictRules) return
    setPinBusy(relPath)
    try {
      const r = await window.api.deploy.conflictRules.set(activeProfileId, relPath, winnerMod)
      if (r.ok) {
        toast.success('File fissato', `"${relPath}" verrà sempre da "${winnerMod}"`)
        await loadRules()
        await runPreview()
      } else toast.error('Fissaggio fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Fissaggio fallito', (e as Error).message)
    } finally {
      setPinBusy(null)
    }
  }

  const removeRule = async (rule: { id: number; relPath: string }) => {
    if (pinBusy || !window.api.deploy.conflictRules) return
    setPinBusy(`remove:${rule.id}`)
    try {
      const r = await window.api.deploy.conflictRules.remove(rule.id)
      if (r.ok) {
        toast.success('Regola rimossa', rule.relPath)
        await loadRules()
        await runPreview()
      } else toast.error('Rimozione fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Rimozione fallita', (e as Error).message)
    } finally {
      setPinBusy(null)
    }
  }

  // Raggruppa i conflitti file per coppia vincitore→perdente (una riga per coppia).
  const conflictPairs = useMemo(() => {
    if (!preview?.ok || !preview.conflicts?.length) return []
    const byPair = new Map<string, { winner: string; loser: string; files: string[] }>()
    for (const c of preview.conflicts) {
      const key = `${c.winner}→${c.loser}`
      const e = byPair.get(key) ?? { winner: c.winner, loser: c.loser, files: [] }
      e.files.push(c.file)
      byPair.set(key, e)
    }
    return [...byPair.values()].sort((a, b) => b.files.length - a.files.length)
  }, [preview])

  const preferLoser = async (pair: { winner: string; loser: string; files: string[] }) => {
    if (activeProfileId == null) return
    const key = `${pair.winner}→${pair.loser}`
    setPreferBusy(key)
    try {
      const r = await window.api.deploy.prefer(activeProfileId, pair.loser, pair.winner)
      if (r.ok) {
        toast.success(
          'Precedenza invertita',
          `"${pair.loser}" ora vince su "${pair.winner}" (${pair.files.length} file) — attivo dal prossimo Deploy`,
        )
        await runPreview() // il piano ricalcolato riflette subito la scelta
      } else toast.error('Inversione fallita', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Inversione fallita', (e as Error).message)
    } finally {
      setPreferBusy(null)
    }
  }

  const errors = conflicts.filter((c) => c.severity === 'error')
  const warnings = conflicts.filter((c) => c.severity === 'warning')
  const okCount = Math.max(
    0,
    mods.filter((m) => m.is_enabled).length - new Set(conflicts.map((c) => c.modId)).size,
  )

  const handleResolve = async (c: ConflictInfo, action: 'disable' | 'priority-top') => {
    await resolveConflict(c.modId, action)
    const label = action === 'disable' ? 'Mod disattivata' : 'Priorità aggiornata'
    toast.success(label, c.modName)
  }

  const resolveAll = async () => {
    const toDisable = conflicts.filter(
      (c) => c.conflictType === 'incompatible' || c.conflictType === 'missing-master',
    )
    for (const c of toDisable) await resolveConflict(c.modId, 'disable')
    toast.success(`${toDisable.length} conflitti risolti`, 'Mod incompatibili disattivate')
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1
          className="text-lg font-bold"
          style={{
            fontFamily: 'Cinzel, serif',
            background: 'linear-gradient(135deg, #fb923c, #f97316)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          Rilevamento Conflitti
        </h1>
        <div className="flex items-center gap-2">
          {conflicts.length > 0 && (
            <button
              onClick={resolveAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-orange-900/30 text-orange-300 hover:bg-orange-900/50 transition-all"
            >
              <Zap size={12} /> Risolvi tutti automaticamente
            </button>
          )}
          <button onClick={detectConflicts} className="btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw size={14} /> Riscansiona
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4" style={{ borderColor: 'rgba(248,113,113,0.3)' }}>
          <div className="flex items-center justify-between">
            <AlertCircle size={18} className="text-red-400" />
            <span className="text-2xl font-bold text-white">{errors.length}</span>
          </div>
          <p className="text-sm text-white/70 mt-1">Errori critici</p>
          <p className="text-xs text-dark-400">Master mancanti, incompatibilità</p>
        </div>
        <div className="card p-4" style={{ borderColor: 'rgba(251,146,60,0.3)' }}>
          <div className="flex items-center justify-between">
            <AlertTriangle size={18} className="text-orange-400" />
            <span className="text-2xl font-bold text-white">{warnings.length}</span>
          </div>
          <p className="text-sm text-white/70 mt-1">Avvertenze</p>
          <p className="text-xs text-dark-400">Conflitti potenziali</p>
        </div>
        <div className="card p-4" style={{ borderColor: 'rgba(74,222,128,0.3)' }}>
          <div className="flex items-center justify-between">
            <CheckCircle size={18} className="text-green-400" />
            <span className="text-2xl font-bold text-white">{okCount}</span>
          </div>
          <p className="text-sm text-white/70 mt-1">Mod senza conflitti</p>
          <p className="text-xs text-dark-400">Compatibili e attive</p>
        </div>
      </div>

      {/* Sovrascritture REALI dal piano di deploy: risoluzione avanzata senza disattivare —
          la mod scelta vince i file contesi alzandone il peso (attivo dal prossimo Deploy). */}
      <div className="card p-5 mb-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-semibold text-white/80 flex items-center gap-2 text-sm">
            <Layers size={15} className="text-void-400" /> Sovrascritture file (piano di deploy)
          </h3>
          <button
            onClick={runPreview}
            disabled={previewBusy || activeProfileId == null}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={previewBusy ? 'animate-spin' : ''} />
            {previewBusy ? 'Analisi…' : 'Analizza conflitti reali'}
          </button>
        </div>
        <p className="text-xs text-dark-400 mb-3">
          Dry-run del piano: per ogni coppia in conflitto vedi chi vince oggi (regole categoria/peso/priorità)
          e puoi <b>invertire la precedenza</b> senza disattivare nulla.
        </p>
        {preview?.ok && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-dark-300 mb-3">
            <span>{preview.modsScanned} mod analizzate</span>
            <span>·</span>
            <span>
              {preview.conflicts?.length ?? 0} file in conflitto ({conflictPairs.length} coppie)
            </span>
            {preview.pluginBudget && (
              <>
                <span>·</span>
                <span
                  className={clsx(
                    preview.pluginBudget.full > preview.pluginBudget.maxFull - 14
                      ? 'text-orange-300'
                      : 'text-dark-300',
                  )}
                >
                  Slot plugin: {preview.pluginBudget.full}/{preview.pluginBudget.maxFull} full ·{' '}
                  {preview.pluginBudget.light} light
                </span>
              </>
            )}
          </div>
        )}
        {preview?.ok && preview.loadOrderIssue && (
          <div className="flex items-start gap-2 rounded-lg bg-red-900/20 border border-red-900/40 px-3 py-2 mb-3 text-xs text-red-300">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            {preview.loadOrderIssue}
          </div>
        )}
        {preview?.ok && conflictPairs.length === 0 && (
          <p className="text-xs text-green-400">
            Nessuna sovrascrittura contesa: ogni file ha un solo fornitore.
          </p>
        )}
        {conflictPairs.length > 0 && (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {conflictPairs.map((p) => {
              const key = `${p.winner}→${p.loser}`
              const expanded = expandedPair === key
              return (
                <div key={key} className="rounded-lg border border-dark-800">
                  <div className="flex items-center gap-3 p-2.5">
                    <button
                      onClick={() => setExpandedPair(expanded ? null : key)}
                      className="flex-1 min-w-0 text-xs text-left"
                      title="Mostra i singoli file contesi per fissarne uno"
                    >
                      <p className="text-white/85 truncate flex items-center gap-1">
                        {expanded ? (
                          <ChevronDown size={12} className="flex-shrink-0" />
                        ) : (
                          <ChevronRight size={12} className="flex-shrink-0" />
                        )}
                        <span className="text-green-400 font-medium">{p.winner}</span>
                        <span className="text-dark-500"> sovrascrive </span>
                        <span className="text-dark-300">{p.loser}</span>
                      </p>
                      <p className="text-dark-500 pl-4">
                        {p.files.length} file contesi · es. {p.files[0]}
                      </p>
                    </button>
                    <button
                      onClick={() => preferLoser(p)}
                      disabled={preferBusy !== null}
                      title={`Al prossimo Deploy "${p.loser}" fornirà TUTTI i file contesi al posto di "${p.winner}"`}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-void-900/40 text-void-300 hover:bg-void-800/60 transition-all disabled:opacity-50 flex-shrink-0"
                    >
                      <ArrowLeftRight size={12} className={preferBusy === key ? 'animate-pulse' : ''} />
                      Inverti precedenza
                    </button>
                  </div>
                  {expanded && (
                    <div className="border-t border-dark-800 px-2.5 py-2 space-y-1">
                      <p className="text-[11px] text-dark-500 mb-1">
                        Fissa un singolo file su "{p.loser}" senza toccare gli altri:
                      </p>
                      {p.files.map((f) => (
                        <div key={f} className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-dark-300 truncate" title={f}>
                            {f}
                          </span>
                          <button
                            onClick={() => pinFile(f, p.loser)}
                            disabled={pinBusy !== null}
                            title={`Fissa "${f}" su "${p.loser}" (indipendente dagli altri file di questa coppia)`}
                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-void-900/40 text-void-300 hover:bg-void-800/60 transition-all disabled:opacity-50 flex-shrink-0"
                          >
                            <Pin size={10} className={pinBusy === f ? 'animate-pulse' : ''} /> Fissa
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {rules.length > 0 && (
          <div className="mt-4 pt-3 border-t border-dark-800">
            <p className="text-xs font-semibold text-white/70 mb-2 flex items-center gap-1.5">
              <Pin size={12} className="text-void-400" /> Regole file attive ({rules.length})
            </p>
            <div className="space-y-1">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 text-xs rounded-lg bg-void-900/20 px-2.5 py-1.5"
                >
                  <span className="text-dark-300 truncate" title={r.relPath}>
                    <span className="text-dark-500">{r.relPath}</span> → sempre da{' '}
                    <span className="text-void-300 font-medium">{r.winnerMod}</span>
                  </span>
                  <button
                    onClick={() => removeRule(r)}
                    disabled={pinBusy !== null}
                    title="Rimuovi questa regola (torna alla risoluzione automatica)"
                    className="flex items-center p-1 rounded text-dark-400 hover:text-red-300 hover:bg-red-900/20 transition-all disabled:opacity-50 flex-shrink-0"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Conflitti record-level DENTRO gli ESP (stile xEdit): stesso FormID toccato da più
          plugin. Rilevazione nativa (indice SQLite incrementale) + tracking della patch di
          risoluzione personale; la risoluzione vera resta in xEdit. */}
      <RecordConflictsCard />

      {conflicts.length === 0 ? (
        <div className="card p-10 flex flex-col items-center text-center">
          <CheckCircle size={48} className="text-green-400 mb-4" />
          <h3 className="text-lg font-semibold text-white/80">Nessun conflitto rilevato</h3>
          <p className="text-dark-400 text-sm mt-2">
            La modlist è compatibile. Tutte le dipendenze sono soddisfatte.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {errors.length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-red-400 mb-2 flex items-center gap-2">
                <AlertCircle size={12} /> Errori critici
              </h3>
              {errors.map((c, i) => (
                <ConflictCard
                  key={i}
                  c={c}
                  onDisable={() => handleResolve(c, 'disable')}
                  onPriorityTop={() => handleResolve(c, 'priority-top')}
                  onGoToCatalog={() => setActivePage('catalog')}
                />
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-orange-400 mb-2 mt-4 flex items-center gap-2">
                <AlertTriangle size={12} /> Avvertenze
              </h3>
              {warnings.map((c, i) => (
                <ConflictCard
                  key={i}
                  c={c}
                  onDisable={() => handleResolve(c, 'disable')}
                  onPriorityTop={() => handleResolve(c, 'priority-top')}
                  onGoToCatalog={() => setActivePage('catalog')}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card p-4 mt-6 flex items-start gap-3">
        <Info size={16} className="text-soul-400 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-dark-300 space-y-1">
          <p>
            <strong className="text-white/70">Master mancante:</strong> La mod richiede un'altra mod non
            installata o attiva.
          </p>
          <p>
            <strong className="text-white/70">Incompatibile:</strong> Due mod esplicitamente incompatibili
            sono entrambe attive.
          </p>
          <p>
            <strong className="text-white/70">Gruppo:</strong> Solo una mod per gruppo body/ENB/perk/magic può
            essere attiva.
          </p>
          <p className="mt-2 text-dark-400">
            Usa LOOT (Strumenti) per risolvere problemi di ordinamento avanzati.
          </p>
        </div>
      </div>
    </div>
  )
}

function ConflictCard({
  c,
  onDisable,
  onPriorityTop,
  onGoToCatalog,
}: {
  c: ConflictInfo
  onDisable: () => void
  onPriorityTop: () => void
  onGoToCatalog: () => void
}) {
  const isError = c.severity === 'error'

  const suggestions = getSuggestions(c)

  return (
    <div className={clsx('card p-3 space-y-2', isError ? 'border-red-900/40' : 'border-orange-900/40')}>
      <div className="flex items-start gap-3">
        {isError ? (
          <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
        ) : (
          <AlertTriangle size={15} className="text-orange-400 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white/85">{c.modName}</p>
          <p className="text-xs text-dark-400 mt-0.5">{c.message}</p>
        </div>
        <span
          className={clsx(
            'text-[10px] font-bold px-2 py-0.5 rounded flex-shrink-0',
            isError ? 'bg-red-900/40 text-red-300' : 'bg-orange-900/40 text-orange-300',
          )}
        >
          {c.conflictType}
        </span>
      </div>

      {suggestions.length > 0 && (
        <div className="flex items-center gap-2 pl-6 flex-wrap">
          <span className="text-xs text-dark-500">Risolvi:</span>
          {suggestions.map((s) => (
            <button
              key={s.label}
              onClick={
                s.action === 'disable'
                  ? onDisable
                  : s.action === 'priority-top'
                    ? onPriorityTop
                    : onGoToCatalog
              }
              className={clsx(
                'flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-all',
                s.variant === 'danger'
                  ? 'bg-red-900/30 text-red-300 hover:bg-red-900/50'
                  : s.variant === 'warn'
                    ? 'bg-orange-900/30 text-orange-300 hover:bg-orange-900/50'
                    : 'bg-void-900/30 text-void-300 hover:bg-void-900/50',
              )}
            >
              <s.icon size={11} />
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Conflitti record-level (dentro gli ESP) ─────────────────────────────────

const STATUS_META: Record<RecordConflictStatus, { label: string; chip: string; badge: string }> = {
  unresolved: {
    label: 'Da risolvere',
    chip: 'bg-red-900/30 text-red-300 hover:bg-red-900/50',
    badge: 'bg-red-900/40 text-red-300',
  },
  shadowed: {
    label: 'Patch scavalcata',
    chip: 'bg-orange-900/30 text-orange-300 hover:bg-orange-900/50',
    badge: 'bg-orange-900/40 text-orange-300',
  },
  identical: {
    label: 'Identici',
    chip: 'bg-dark-800 text-dark-300 hover:bg-dark-700',
    badge: 'bg-dark-800 text-dark-300',
  },
  resolved: {
    label: 'Risolti',
    chip: 'bg-green-900/30 text-green-300 hover:bg-green-900/50',
    badge: 'bg-green-900/40 text-green-300',
  },
  ignored: {
    label: 'Ignorati',
    chip: 'bg-dark-800 text-dark-400 hover:bg-dark-700',
    badge: 'bg-dark-800 text-dark-400',
  },
}
const STATUS_ORDER: RecordConflictStatus[] = ['unresolved', 'shadowed', 'identical', 'resolved', 'ignored']

// Etichette leggibili per le signature più comuni (le altre mostrano il 4cc nudo).
const SIG_LABELS: Record<string, string> = {
  WEAP: 'Arma',
  ARMO: 'Armatura',
  NPC_: 'NPC',
  WTHR: 'Meteo',
  CELL: 'Cella',
  REFR: 'Reference',
  LVLI: 'Lista livellata',
  LVLN: 'NPC livellato',
  PERK: 'Perk',
  SPEL: 'Incantesimo',
  MGEF: 'Effetto magico',
  RACE: 'Razza',
  QUST: 'Quest',
  GMST: 'Game setting',
  INGR: 'Ingrediente',
  ALCH: 'Pozione',
  BOOK: 'Libro',
  STAT: 'Statico',
  TREE: 'Albero',
  FLOR: 'Flora',
  LIGH: 'Luce',
  IMGS: 'Imagespace',
}

function RecordConflictsCard() {
  const [scanBusy, setScanBusy] = useState(false)
  const [progress, setProgress] = useState<RecordConflictScanProgress | null>(null)
  const [report, setReport] = useState<{
    patchName?: string
    summary?: RecordConflictSummary
    items?: RecordConflictItem[]
    truncated?: boolean
  } | null>(null)
  const [statusFilter, setStatusFilter] = useState<Set<RecordConflictStatus>>(new Set())
  const [search, setSearch] = useState('')
  const [ignoreBusy, setIgnoreBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api.conflicts) return
    const unsub = window.api.conflicts.onProgress((p) => setProgress(p))
    return unsub
  }, [])

  const loadReport = useCallback(async (filters?: { statuses?: RecordConflictStatus[]; search?: string }) => {
    if (!window.api.conflicts) return
    try {
      const r = await window.api.conflicts.report({
        statuses: filters?.statuses,
        search: filters?.search,
      })
      if (r.ok) setReport(r)
      else toast.error('Report conflitti fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Report conflitti fallito', (e as Error).message)
    }
  }, [])

  const currentFilters = useCallback(
    () => ({
      statuses: statusFilter.size > 0 ? [...statusFilter] : undefined,
      search: search.trim() || undefined,
    }),
    [statusFilter, search],
  )

  // Il refetch parte quando cambiano i filtri, ma solo dopo il primo report (il primo
  // load è esplicito: bottone Scansiona o Aggiorna).
  useEffect(() => {
    if (report === null) return
    void loadReport(currentFilters())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, search])

  const runScan = async () => {
    if (!window.api.conflicts || scanBusy) return
    setScanBusy(true)
    setProgress(null)
    try {
      const r = await window.api.conflicts.scan()
      if (!r.ok) {
        toast.error('Scansione conflitti fallita', r.error ?? 'errore sconosciuto')
        return
      }
      const s = r.summary
      toast.success(
        'Scansione completata',
        s
          ? `${r.pluginsActive} plugin (${s.indexed} riletti, ${s.cached} in cache${s.failed.length ? `, ${s.failed.length} falliti` : ''})`
          : `${r.pluginsActive} plugin`,
      )
      await loadReport(currentFilters())
    } catch (e) {
      toast.error('Scansione conflitti fallita', (e as Error).message)
    } finally {
      setScanBusy(false)
      setProgress(null)
    }
  }

  const toggleStatus = (s: RecordConflictStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  const toggleIgnore = async (item: RecordConflictItem) => {
    if (!window.api.conflicts || ignoreBusy) return
    setIgnoreBusy(item.formKey)
    try {
      const makeIgnored = item.status !== 'ignored'
      const r = await window.api.conflicts.setIgnored(item.formKey, makeIgnored)
      if (r.ok) await loadReport(currentFilters())
      else toast.error('Aggiornamento fallito', r.error ?? 'errore sconosciuto')
    } catch (e) {
      toast.error('Aggiornamento fallito', (e as Error).message)
    } finally {
      setIgnoreBusy(null)
    }
  }

  const items = report?.items ?? []
  const summary = report?.summary

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-semibold text-white/80 flex items-center gap-2 text-sm">
          <Swords size={15} className="text-void-400" /> Conflitti di record (dentro gli ESP)
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.api.tools.launchSSEEdit()}
            className="btn-ghost flex items-center gap-1.5 text-xs"
            title="Apri SSEEdit per risolvere i conflitti nella patch personale"
          >
            <ExternalLink size={12} /> Apri SSEEdit
          </button>
          <button
            onClick={runScan}
            disabled={scanBusy}
            className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={scanBusy ? 'animate-spin' : ''} />
            {scanBusy ? 'Scansione…' : report ? 'Riscansiona' : 'Scansiona record'}
          </button>
        </div>
      </div>
      <p className="text-xs text-dark-400 mb-3">
        Stesso record (FormID) modificato da più plugin: chi carica per ultimo vince. Qui vedi DOVE serve una
        decisione e quali conflitti la tua patch{' '}
        <span className="text-void-300 font-medium">{report?.patchName ?? 'FantasyLauncher_Output.esp'}</span>{' '}
        copre già — la risoluzione campo-per-campo si fa in SSEEdit.
      </p>

      {scanBusy && progress && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-dark-300 mb-1">
            <span className="truncate">{progress.plugin}</span>
            <span>
              {progress.done}/{progress.total}
            </span>
          </div>
          <div className="h-1.5 rounded bg-dark-800 overflow-hidden">
            <div
              className="h-full bg-void-500 transition-all"
              style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {summary && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={clsx(
                'flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-all',
                STATUS_META[s].chip,
                statusFilter.size > 0 && !statusFilter.has(s) && 'opacity-40',
              )}
              title={
                statusFilter.has(s)
                  ? 'Rimuovi dal filtro'
                  : 'Mostra solo questo stato (clic su più stati per combinarli)'
              }
            >
              {STATUS_META[s].label}
              <span className="font-bold">{summary.byStatus[s]}</span>
            </button>
          ))}
          <div className="relative ml-auto">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-dark-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filtra per EDID, plugin, signature…"
              className="bg-dark-900 border border-dark-800 rounded-lg pl-7 pr-2 py-1 text-xs text-white/85 placeholder:text-dark-500 w-64 focus:outline-none focus:border-void-700"
            />
          </div>
        </div>
      )}

      {report === null && !scanBusy && (
        <p className="text-xs text-dark-500">
          Nessuna scansione ancora: premi <b>Scansiona record</b>. La prima passata legge tutti i plugin
          attivi (decine di secondi su una collezione grande); le successive rileggono solo i file cambiati.
        </p>
      )}
      {report !== null && summary && summary.total === 0 && (
        <p className="text-xs text-green-400">Nessun conflitto di record tra i plugin attivi.</p>
      )}
      {report !== null && items.length === 0 && summary && summary.total > 0 && (
        <p className="text-xs text-dark-400">Nessun conflitto corrisponde ai filtri correnti.</p>
      )}

      {items.length > 0 && (
        <>
          <Virtuoso
            style={{ height: 420 }}
            data={items}
            initialItemCount={Math.min(items.length, 15)}
            computeItemKey={(i, item) => item?.formKey ?? i}
            itemContent={(_i, item) =>
              // Durante lo swap di `data` verso un array più corto (cambio filtro) Virtuoso
              // può chiedere transitoriamente un indice oltre la nuova lunghezza.
              item ? (
                <RecordConflictRow
                  item={item}
                  busy={ignoreBusy === item.formKey}
                  onToggleIgnore={() => toggleIgnore(item)}
                />
              ) : null
            }
          />
          {report?.truncated && (
            <p className="text-[11px] text-dark-500 mt-2">
              Elenco troncato: affina i filtri per vedere le voci rimanenti (il riepilogo in alto conta
              comunque tutto).
            </p>
          )}
        </>
      )}
    </div>
  )
}

function RecordConflictRow({
  item,
  busy,
  onToggleIgnore,
}: {
  item: RecordConflictItem
  busy: boolean
  onToggleIgnore: () => void
}) {
  const meta = STATUS_META[item.status]
  const sigLabel = SIG_LABELS[item.signature]
  const isIgnored = item.status === 'ignored'
  return (
    <div className="flex items-center gap-3 border-b border-dark-800/60 py-2 pr-1 text-xs">
      <span
        className={clsx(
          'text-[10px] font-bold px-2 py-0.5 rounded flex-shrink-0 w-28 text-center',
          meta.badge,
        )}
      >
        {meta.label}
      </span>
      <span
        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-dark-900 text-dark-300 flex-shrink-0"
        title={sigLabel ?? item.signature}
      >
        {item.signature}
        {sigLabel ? ` · ${sigLabel}` : ''}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-white/85 truncate" title={item.formKey}>
          {item.edid ?? item.formKey}
        </p>
        <p className="text-dark-500 truncate" title={item.participants.map((p) => p.displayName).join(' → ')}>
          {item.participants.map((p, idx) => (
            <span key={p.plugin + idx}>
              {idx > 0 && <span className="text-dark-600"> → </span>}
              <span
                className={clsx(
                  p.plugin === item.winner ? 'text-green-400' : p.isOwn ? 'text-dark-400' : 'text-dark-300',
                )}
              >
                {p.displayName}
              </span>
            </span>
          ))}
        </p>
      </div>
      <button
        onClick={onToggleIgnore}
        disabled={busy}
        title={isIgnored ? 'Riporta tra i conflitti da valutare' : 'Segna come non-problema (persistito)'}
        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-dark-900 text-dark-300 hover:bg-dark-800 transition-all disabled:opacity-50 flex-shrink-0"
      >
        {isIgnored ? <Eye size={11} /> : <EyeOff size={11} />}
        {isIgnored ? 'Riattiva' : 'Ignora'}
      </button>
    </div>
  )
}

function getSuggestions(c: ConflictInfo) {
  const suggestions: {
    label: string
    action: string
    icon: React.ElementType
    variant: 'danger' | 'warn' | 'info'
  }[] = []

  if (c.conflictType === 'missing-master') {
    suggestions.push({ label: 'Cerca nel catalogo', action: 'catalog', icon: CheckCircle, variant: 'info' })
    suggestions.push({ label: 'Disattiva mod', action: 'disable', icon: PowerOff, variant: 'danger' })
  } else if (c.conflictType === 'incompatible') {
    suggestions.push({ label: 'Disattiva questa mod', action: 'disable', icon: PowerOff, variant: 'danger' })
  } else if (c.conflictType === 'overwrite') {
    suggestions.push({
      label: 'Porta in cima (priorità 0)',
      action: 'priority-top',
      icon: ArrowUp,
      variant: 'warn',
    })
    suggestions.push({ label: 'Disattiva mod', action: 'disable', icon: PowerOff, variant: 'danger' })
  }

  return suggestions
}
