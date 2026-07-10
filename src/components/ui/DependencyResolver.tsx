import { useEffect, useState, useCallback } from 'react'
import {
  Boxes,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRight,
  PackageSearch,
  Play,
  Layers,
  Target,
  Link2,
  ShieldCheck,
} from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from '@/lib/toast'
import type { CatalogMod } from '@/types'

// Types reused straight from the already-typed preload contract (src/types/index.ts)
// so the component can never drift from the backend InstallPlanResult shape.
type InstallPlanResult = Awaited<ReturnType<Window['api']['catalog']['resolvePlan']>>
type PlanItem = NonNullable<InstallPlanResult['plan']>[number]
type PlanConflict = NonNullable<InstallPlanResult['conflicts']>[number]
type AutoResolvedConflict = NonNullable<InstallPlanResult['resolvedConflicts']>[number]

export interface DependencyResolverProps {
  /** nexus_ids the user selected to install. */
  selected: Set<number>
  /** nexus_ids already installed (excluded from the plan). Defaults to empty. */
  installed?: Set<number>
  /** Hand the resolved, ordered plan to the installer/queue. */
  onProceed?: (plan: PlanItem[]) => void
}

interface ModMeta {
  name: string
  priority: number
}

export default function DependencyResolver({ selected, installed, onProceed }: DependencyResolverProps) {
  const [meta, setMeta] = useState<Map<number, ModMeta>>(new Map())
  const [result, setResult] = useState<InstallPlanResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  // Catalog lookup: names + priorities for the ids the resolver returns by number
  // only (cycle path, the other side of a conflict).
  useEffect(() => {
    let alive = true
    window.api?.catalog
      ?.list()
      .then((mods: CatalogMod[]) => {
        if (!alive) return
        setMeta(new Map(mods.map((m) => [m.nexus_id, { name: m.name, priority: m.priority_order }])))
      })
      .catch(() => {
        /* names simply fall back to #id */
      })
    return () => {
      alive = false
    }
  }, [])

  const nameOf = useCallback((id: number) => meta.get(id)?.name ?? `#${id}`, [meta])
  const priorityOf = useCallback((id: number) => meta.get(id)?.priority, [meta])

  // Any change to the selection invalidates a previous analysis.
  useEffect(() => {
    setResult(null)
  }, [selected, installed])

  const analyze = useCallback(async () => {
    if (selected.size === 0) return
    const api = window.api?.catalog?.resolvePlan
    if (!api) {
      toast.error('Resolver non disponibile', 'window.api.catalog.resolvePlan mancante')
      return
    }
    setAnalyzing(true)
    setResult(null)
    try {
      const res = await api(Array.from(selected), Array.from(installed ?? []))
      setResult(res)
      // A 'db' errorKind is a SYSTEM failure, not a user-fixable plan problem.
      if (!res.success && res.errorKind === 'db') {
        toast.error('Errore di sistema', res.errors?.join('; ') ?? 'Risoluzione dipendenze fallita')
      }
    } catch (e) {
      toast.error('Errore di sistema', (e as Error).message)
      setResult({ success: false, errorKind: 'db', errors: [(e as Error).message] })
    } finally {
      setAnalyzing(false)
    }
  }, [selected, installed])

  const proceed = useCallback(() => {
    if (!result?.success || !result.plan?.length) return
    onProceed?.(result.plan)
    toast.success('Piano inoltrato', `${result.plan.length} mod pronte per l'installazione`)
  }, [result, onProceed])

  return (
    <div className="card p-5 space-y-4">
      <Header count={selected.size} analyzing={analyzing} onAnalyze={analyze} />

      {!result && !analyzing && <EmptyState count={selected.size} />}
      {analyzing && <Analyzing />}

      {result?.success && result.plan && (
        <SuccessView plan={result.plan} onProceed={proceed} />
      )}
      {result && !result.success && result.errorKind === 'cycle' && (
        <CycleView path={result.cyclePath ?? []} nameOf={nameOf} />
      )}
      {result && !result.success && result.errorKind === 'conflict' && (
        <ConflictView conflicts={result.conflicts ?? []} nameOf={nameOf} priorityOf={priorityOf} />
      )}
      {result && !result.success && result.errorKind === 'missing' && (
        <MissingView errors={result.errors ?? []} />
      )}
      {result && !result.success && result.errorKind === 'db' && (
        <SystemError error={result.errors?.join('; ')} />
      )}

      {result?.resolvedConflicts && result.resolvedConflicts.length > 0 && (
        <AutoResolvedView conflicts={result.resolvedConflicts} />
      )}
    </div>
  )
}

// ── Header + states ────────────────────────────────────────────────────────────

function Header({ count, analyzing, onAnalyze }: { count: number; analyzing: boolean; onAnalyze: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-void-900/50 flex items-center justify-center">
          <Boxes size={18} className="text-void-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90">Dependency Resolver</h3>
          <p className="text-xs text-dark-400">
            {count} mod selezionate
          </p>
        </div>
      </div>
      <button
        onClick={onAnalyze}
        disabled={analyzing || count === 0}
        className="btn-primary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {analyzing ? <Loader2 size={15} className="animate-spin" /> : <PackageSearch size={15} />}
        {analyzing ? 'Analisi…' : 'Analizza Dipendenze'}
      </button>
    </div>
  )
}

function EmptyState({ count }: { count: number }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <Layers size={28} className="text-dark-500" />
      <p className="text-sm text-dark-300">
        {count === 0 ? 'Seleziona una o più mod per calcolare il piano.' : 'Pronto ad analizzare le dipendenze.'}
      </p>
    </div>
  )
}

function Analyzing() {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-dark-300">
      <Loader2 size={18} className="animate-spin text-void-400" />
      <span className="text-sm">Calcolo del piano d'installazione…</span>
    </div>
  )
}

// ── Success ─────────────────────────────────────────────────────────────────────

function SuccessView({ plan, onProceed }: { plan: PlanItem[]; onProceed: () => void }) {
  return (
    <div className="space-y-3">
      <Banner tone="success" icon={CheckCircle2}>
        Piano valido — {plan.length} mod in ordine d'installazione (le dipendenze prima).
      </Banner>
      <ol className="space-y-1.5">
        {plan.map((item, i) => (
          <li
            key={item.nexus_id}
            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-dark-800/40 border border-dark-700/40"
          >
            <span className="w-6 text-right text-xs font-mono text-dark-500">{i + 1}</span>
            <span className="flex-1 min-w-0 truncate text-sm text-white/90">{item.name}</span>
            <span
              className={clsx(
                'flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded',
                item.reason === 'target'
                  ? 'bg-void-900/50 text-void-300'
                  : 'bg-dark-700/50 text-dark-300',
              )}
              title={item.reason === 'target' ? 'Mod selezionata' : 'Dipendenza risolta'}
            >
              {item.reason === 'target' ? <Target size={10} /> : <Link2 size={10} />}
              {item.reason === 'target' ? 'target' : 'dipendenza'}
            </span>
            <span
              className="text-[10px] font-mono text-dark-400 tabular-nums"
              title="priority_order (ordine di caricamento)"
            >
              P{item.priority_order}
            </span>
          </li>
        ))}
      </ol>
      <button onClick={onProceed} className="btn-primary w-full flex items-center justify-center gap-2">
        <Play size={15} />
        Procedi all'Installazione
      </button>
    </div>
  )
}

// ── Conflict ─────────────────────────────────────────────────────────────────────

function ConflictView({
  conflicts,
  nameOf,
  priorityOf,
}: {
  conflicts: PlanConflict[]
  nameOf: (id: number) => string
  priorityOf: (id: number) => number | undefined
}) {
  const pr = (id: number) => {
    const p = priorityOf(id)
    return p == null ? '?' : `P${p}`
  }
  return (
    <div className="space-y-3">
      <Banner tone="danger" icon={XCircle}>
        Conflitti rilevati — impossibile procedere finché non vengono risolti.
      </Banner>
      <ul className="space-y-2">
        {conflicts.map((c, i) => (
          <li
            key={`${c.mod}-${c.conflictsWith}-${i}`}
            className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-red-950/30 border border-red-900/40"
          >
            <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-white/90 leading-relaxed">
              <span className="font-semibold text-red-300">{c.modName}</span>{' '}
              <span className="text-xs font-mono text-dark-400">({pr(c.mod)})</span>{' '}
              sovrascrive i file di{' '}
              <span className="font-semibold text-red-300">{nameOf(c.conflictsWith)}</span>{' '}
              <span className="text-xs font-mono text-dark-400">({pr(c.conflictsWith)})</span>
              <span className="block text-xs text-dark-400 mt-0.5">
                {c.offender === 'installed'
                  ? 'Il mod in conflitto è già installato.'
                  : 'Entrambi verrebbero aggiunti in questo piano.'}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Auto-resolved conflicts (informational, NOT errors) ──────────────────────────

/**
 * Conflicts the system resolved on its own via the category/weight/priority rules.
 * Rendered in a neutral sky/slate palette — these are automated *choices*, not
 * problems: the user can audit them but never has to act.
 */
function AutoResolvedView({ conflicts }: { conflicts: AutoResolvedConflict[] }) {
  return (
    <div className="space-y-3">
      <Banner tone="info" icon={ShieldCheck}>
        {conflicts.length} conflitt{conflicts.length === 1 ? 'o' : 'i'} auto-risolt
        {conflicts.length === 1 ? 'o' : 'i'} — scelte applicate dal sistema, nessun intervento richiesto.
      </Banner>
      <ul className="space-y-1.5">
        {conflicts.map((c, i) => (
          <li
            key={`${c.file}-${c.loser}-${i}`}
            className="flex items-start gap-3 px-3 py-2 rounded-lg bg-dark-800/40 border border-dark-700/40"
          >
            <ShieldCheck size={15} className="text-sky-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0 text-sm leading-relaxed">
              <span className="block truncate font-mono text-xs text-dark-300" title={c.file}>
                {c.file}
              </span>
              <span className="block text-xs text-dark-400 mt-0.5">
                <span className="font-medium text-sky-300">{c.winner}</span> vince su{' '}
                <span className="text-dark-500 line-through">{c.loser}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Cycle ─────────────────────────────────────────────────────────────────────

/** Format a cyclePath (nexus_ids, first === last) into labelled graph nodes. */
function formatCycleNodes(path: number[], nameOf: (id: number) => string): string[] {
  return path.map(nameOf)
}

function CycleView({ path, nameOf }: { path: number[]; nameOf: (id: number) => string }) {
  const nodes = formatCycleNodes(path, nameOf)
  return (
    <div className="space-y-3">
      <Banner tone="danger" icon={XCircle}>
        Ciclo di dipendenze — impossibile procedere. Spezza il ciclo rimuovendo una delle dipendenze.
      </Banner>
      <div className="flex flex-wrap items-center gap-2 px-3 py-3 rounded-lg bg-red-950/30 border border-red-900/40">
        {nodes.map((n, i) => (
          <span key={i} className="flex items-center gap-2">
            <span
              className={clsx(
                'px-2.5 py-1 rounded-md text-sm font-medium border',
                i === 0 || i === nodes.length - 1
                  ? 'bg-red-900/50 text-red-200 border-red-700/60'
                  : 'bg-dark-800/60 text-white/90 border-dark-700/50',
              )}
            >
              {n}
            </span>
            {i < nodes.length - 1 && <ArrowRight size={15} className="text-red-400 flex-shrink-0" />}
          </span>
        ))}
      </div>
      <p className="text-xs text-dark-400">
        Il primo e l'ultimo nodo coincidono: la catena si richiude su sé stessa.
      </p>
    </div>
  )
}

// ── Missing ─────────────────────────────────────────────────────────────────────

function MissingView({ errors }: { errors: string[] }) {
  return (
    <div className="space-y-3">
      <Banner tone="warning" icon={AlertTriangle}>
        Dipendenze mancanti — alcune mod richieste non sono nel catalogo.
      </Banner>
      <ul className="space-y-1.5">
        {errors.map((e, i) => (
          <li
            key={i}
            className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-950/20 border border-amber-900/30 text-sm text-amber-200"
          >
            <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <span>{e}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SystemError({ error }: { error?: string }) {
  return (
    <Banner tone="danger" icon={XCircle}>
      Errore di sistema durante la risoluzione. {error}
    </Banner>
  )
}

// ── Shared banner ────────────────────────────────────────────────────────────────

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'success' | 'danger' | 'warning' | 'info'
  icon: React.ElementType
  children: React.ReactNode
}) {
  const map = {
    success: 'bg-green-950/30 border-green-900/40 text-green-300',
    danger: 'bg-red-950/30 border-red-900/40 text-red-300',
    warning: 'bg-amber-950/20 border-amber-900/30 text-amber-300',
    info: 'bg-sky-950/30 border-sky-900/40 text-sky-300',
  }
  const iconColor = {
    success: 'text-green-400',
    danger: 'text-red-400',
    warning: 'text-amber-400',
    info: 'text-sky-400',
  }
  return (
    <div className={clsx('flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm', map[tone])}>
      <Icon size={16} className={clsx('flex-shrink-0', iconColor[tone])} />
      <span>{children}</span>
    </div>
  )
}
