import { useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  Info,
  RefreshCw,
  Cpu,
  FileCode,
  Package,
  CheckCircle,
  XCircle,
  HelpCircle,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '@/store/appStore'
import type { CompatAnalysis, CompatFinding, Severity } from '@/lib/compatibility'

const SEV: Record<Severity, { icon: React.ElementType; color: string; chip: string; label: string }> = {
  error: { icon: AlertCircle, color: 'text-red-400', chip: 'bg-red-900/40 text-red-300', label: 'Errori' },
  warning: {
    icon: AlertTriangle,
    color: 'text-orange-400',
    chip: 'bg-orange-900/40 text-orange-300',
    label: 'Avvertenze',
  },
  info: { icon: Info, color: 'text-soul-400', chip: 'bg-soul-900/40 text-soul-300', label: 'Note' },
}

export default function Compatibility() {
  // Re-run when the mod set changes so the report tracks the live modlist.
  const mods = useAppStore((s) => s.mods)
  const [analysis, setAnalysis] = useState<CompatAnalysis | null>(null)
  const [loading, setLoading] = useState(false)

  const analyze = useCallback(async () => {
    setLoading(true)
    try {
      setAnalysis(await window.api.compat.analyze())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    analyze()
  }, [analyze, mods])

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="text-lg font-bold"
            style={{
              fontFamily: 'Cinzel, serif',
              background: 'linear-gradient(135deg, #7d4dff, #4d7dff)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Compatibilità
          </h1>
          <p className="text-xs text-dark-400 mt-1">
            Versione runtime del gioco + SKSE e analisi della modlist dal load order attivo.
          </p>
        </div>
        <button
          onClick={analyze}
          disabled={loading}
          className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Rianalizza
        </button>
      </div>

      {!analysis ? (
        <div className="card p-10 flex flex-col items-center text-center text-dark-400">
          <RefreshCw size={32} className="animate-spin mb-3" />
          <p className="text-sm">Analisi compatibilità in corso…</p>
        </div>
      ) : (
        <>
          {/* Runtime + summary cards */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard
              icon={Package}
              iconClass="text-void-400"
              value={analysis.skyrim.version ?? '—'}
              label="Skyrim runtime"
              hint={analysis.skyrim.installed ? 'Address Library rilevata' : 'gioco non rilevato'}
            />
            <SkseCard skse={analysis.skse} />
            <StatCard
              icon={FileCode}
              iconClass="text-soul-400"
              value={String(
                analysis.report.pluginCounts.esm +
                  analysis.report.pluginCounts.esp +
                  analysis.report.pluginCounts.esl,
              )}
              label="Plugin attivi"
              hint={pluginSourceLabel(analysis.pluginSource)}
            />
            <StatCard
              icon={analysis.report.ok ? ShieldCheck : AlertCircle}
              iconClass={analysis.report.ok ? 'text-green-400' : 'text-red-400'}
              value={analysis.report.ok ? 'OK' : `${analysis.report.totals.error}`}
              label={analysis.report.ok ? 'Nessun blocco' : 'Errori critici'}
              hint={`${analysis.report.totals.warning} avvertenze · ${analysis.report.totals.info} note`}
            />
          </div>

          {/* Plugin classification + load-order budget */}
          <div className="card p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold uppercase tracking-widest text-dark-300">
                Classificazione plugin
              </h3>
              <span className="text-xs text-dark-500">{pluginSourceLabel(analysis.pluginSource)}</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <TypeChip
                label="ESM (master)"
                value={analysis.report.pluginCounts.esm}
                cls="text-soul-300 bg-soul-900/30"
              />
              <TypeChip
                label="ESP (full)"
                value={analysis.report.pluginCounts.esp}
                cls="text-void-300 bg-void-900/30"
              />
              <TypeChip
                label="ESL (light)"
                value={analysis.report.pluginCounts.esl}
                cls="text-green-300 bg-green-900/30"
              />
              {analysis.report.pluginCounts.unknown > 0 && (
                <TypeChip
                  label="sconosciuti"
                  value={analysis.report.pluginCounts.unknown}
                  cls="text-dark-300 bg-dark-700/50"
                />
              )}
            </div>
            <LoadOrderBar esm={analysis.report.pluginCounts.esm} esp={analysis.report.pluginCounts.esp} />
          </div>

          {/* Findings */}
          {analysis.report.findings.length === 0 ? (
            <div className="card p-10 flex flex-col items-center text-center">
              <CheckCircle size={48} className="text-green-400 mb-4" />
              <h3 className="text-lg font-semibold text-white/80">Modlist compatibile</h3>
              <p className="text-dark-400 text-sm mt-2">
                Nessun problema rilevato su dipendenze, framework, versioni o load order.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {(['error', 'warning', 'info'] as Severity[]).map((sev) => {
                const items = analysis.report.findings.filter((f) => f.severity === sev)
                if (items.length === 0) return null
                const cfg = SEV[sev]
                return (
                  <div key={sev}>
                    <h3
                      className={clsx(
                        'text-xs font-bold uppercase tracking-widest mb-2 flex items-center gap-2',
                        cfg.color,
                      )}
                    >
                      <cfg.icon size={12} /> {cfg.label} ({items.length})
                    </h3>
                    <div className="space-y-2">
                      {items.map((f) => (
                        <FindingCard key={f.id} f={f} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="card p-4 mt-6 flex items-start gap-3">
            <Info size={16} className="text-soul-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-dark-300 space-y-1">
              <p>
                <strong className="text-white/70">Versione runtime (T5):</strong> ricavata dall'Address
                Library installata; SKSE è compatibile solo se la build corrisponde al runtime del gioco.
              </p>
              <p>
                <strong className="text-white/70">Plugin (T3):</strong> in Electron la classificazione usa il{' '}
                <code>plugins.txt</code> del profilo MO2 attivo; nel preview browser è derivata dalle mod
                installate.
              </p>
              <p className="text-dark-400">
                Limite load order: 254 slot ESP/ESM. Gli ESL sono "light" e non consumano slot standard.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function pluginSourceLabel(src: CompatAnalysis['pluginSource']): string {
  if (src === 'plugins.txt') return 'da plugins.txt (MO2)'
  if (src === 'derived') return 'derivati dalle mod'
  return 'nessun plugins.txt'
}

function StatCard({
  icon: Icon,
  iconClass,
  value,
  label,
  hint,
}: {
  icon: React.ElementType
  iconClass: string
  value: string
  label: string
  hint: string
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <Icon size={18} className={iconClass} />
        <span className="text-xl font-bold text-white truncate" title={value}>
          {value}
        </span>
      </div>
      <p className="text-sm text-white/70 mt-1">{label}</p>
      <p className="text-xs text-dark-400 truncate" title={hint}>
        {hint}
      </p>
    </div>
  )
}

function SkseCard({ skse }: { skse: CompatAnalysis['skse'] }) {
  const supported = skse.gameVersionSupported
  const badge = !skse.present
    ? { icon: XCircle, cls: 'text-red-400', txt: 'assente' }
    : supported === true
      ? { icon: CheckCircle, cls: 'text-green-400', txt: 'compatibile' }
      : supported === false
        ? { icon: AlertCircle, cls: 'text-red-400', txt: 'mismatch versione' }
        : { icon: HelpCircle, cls: 'text-dark-400', txt: 'non determinabile' }
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <Cpu size={18} className="text-void-400" />
        <span className={clsx('text-xl font-bold', badge.cls)}>{skse.version ?? '—'}</span>
      </div>
      <p className="text-sm text-white/70 mt-1">SKSE64</p>
      <p className={clsx('text-xs flex items-center gap-1', badge.cls)}>
        <badge.icon size={11} /> {badge.txt}
      </p>
    </div>
  )
}

function TypeChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg', cls)}>
      <span className="text-base font-bold">{value}</span>
      <span className="text-xs opacity-80">{label}</span>
    </div>
  )
}

function LoadOrderBar({ esm, esp }: { esm: number; esp: number }) {
  const used = esm + esp
  const pct = Math.min(100, (used / 254) * 100)
  const danger = used > 254,
    near = used > 220
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-dark-400">Slot ESP/ESM usati</span>
        <span
          className={clsx(
            'font-semibold',
            danger ? 'text-red-400' : near ? 'text-orange-400' : 'text-white/70',
          )}
        >
          {used} / 254
        </span>
      </div>
      <div className="h-2 rounded-full bg-dark-800 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            background: danger ? '#ef4444' : near ? '#fb923c' : 'linear-gradient(90deg,#7d4dff,#4d7dff)',
          }}
        />
      </div>
    </div>
  )
}

function FindingCard({ f }: { f: CompatFinding }) {
  const cfg = SEV[f.severity]
  return (
    <div className="card p-3 flex items-start gap-3">
      <cfg.icon size={15} className={clsx('flex-shrink-0 mt-0.5', cfg.color)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white/85">{f.label}</p>
        <p className="text-xs text-dark-400 mt-0.5">{f.detail}</p>
      </div>
    </div>
  )
}
