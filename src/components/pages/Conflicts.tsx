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
} from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from '@/components/ui/Toast'
import type { ConflictInfo } from '@/types'

export default function Conflicts() {
  const { conflicts, mods, detectConflicts, resolveConflict, setActivePage } = useAppStore()

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
