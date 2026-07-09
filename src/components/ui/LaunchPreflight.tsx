import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  MinusCircle,
  Play,
  X,
  Loader,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
} from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from './Toast'

interface Check {
  stage: string
  status: 'ok' | 'warning' | 'fail' | 'skipped'
  label: string
  detail: string
  fix?: string
  critical: boolean
}
interface Report {
  checks: Check[]
  canLaunch: boolean
  blockingStage: string | null
  firstFix: string | null
  totals: { ok: number; warning: number; fail: number; skipped: number }
}

const ICON = {
  ok: <CheckCircle size={15} className="text-green-400" />,
  warning: <AlertTriangle size={15} className="text-orange-400" />,
  fail: <XCircle size={15} className="text-red-400" />,
  skipped: <MinusCircle size={15} className="text-dark-500" />,
}

export function LaunchPreflight({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState(false)

  const api = window.api as unknown as {
    launch: { preflight: () => Promise<Report>; run: () => Promise<{ launched: boolean; report: Report }> }
  }

  const run = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await api.launch.preflight())
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    run()
  }, [run])

  const launch = async () => {
    setLaunching(true)
    try {
      const res = await api.launch.run()
      if (res.launched) {
        toast.success('Avvio in corso', 'Skyrim AE avviato tramite Mod Organizer 2 / SKSE')
        onClose()
      } else {
        setReport(res.report)
        toast.error('Avvio bloccato', res.report.firstFix ?? 'Prerequisiti mancanti')
      }
    } finally {
      setLaunching(false)
    }
  }

  return (
    <>
      <div
        data-close-on-escape
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[36rem] max-h-[80vh] flex flex-col rounded-xl shadow-2xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-dark-800 flex-shrink-0">
          <h2
            className="font-bold text-white/90 flex items-center gap-2"
            style={{ fontFamily: 'Cinzel, serif' }}
          >
            {report?.canLaunch ? (
              <ShieldCheck size={18} className="text-green-400" />
            ) : (
              <ShieldAlert size={18} className="text-orange-400" />
            )}
            Controllo pre-avvio
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={run}
              title="Riscansiona"
              className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-white hover:bg-white/10"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-white hover:bg-white/10"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Checklist */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {loading && !report ? (
            <div className="flex items-center justify-center gap-2 py-12 text-dark-400">
              <Loader size={18} className="animate-spin" /> Verifica prerequisiti…
            </div>
          ) : (
            report?.checks.map((c, i) => (
              <div
                key={i}
                className={clsx(
                  'flex items-start gap-3 p-2.5 rounded-lg',
                  c.status === 'fail' && 'bg-red-900/15',
                  c.status === 'warning' && 'bg-orange-900/10',
                )}
              >
                <span className="mt-0.5 flex-shrink-0">{ICON[c.status]}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/85">{c.label}</span>
                    <span className="text-[10px] text-dark-500 font-mono uppercase">{c.stage}</span>
                  </div>
                  <p className="text-xs text-dark-400">{c.detail}</p>
                  {c.fix && c.status !== 'ok' && <p className="text-xs text-soul-300 mt-0.5">→ {c.fix}</p>}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-dark-800 flex items-center justify-between flex-shrink-0">
          <div className="text-xs text-dark-400">
            {report && (
              <span>
                <span className="text-green-400">{report.totals.ok} ok</span> ·{' '}
                <span className="text-orange-400">{report.totals.warning} avvisi</span> ·{' '}
                <span className="text-red-400">{report.totals.fail} bloccanti</span>
              </span>
            )}
          </div>
          <button
            onClick={launch}
            disabled={!report?.canLaunch || launching}
            className={clsx(
              'flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition-all',
              report?.canLaunch ? 'text-white hover:scale-105' : 'text-dark-500 cursor-not-allowed',
            )}
            style={
              report?.canLaunch
                ? {
                    background: 'linear-gradient(135deg, #ff4500, #ff6a2e)',
                    boxShadow: '0 0 20px rgba(255,69,0,0.3)',
                  }
                : { background: 'rgba(255,255,255,0.05)' }
            }
            title={report?.canLaunch ? 'Avvia il gioco' : (report?.firstFix ?? 'Prerequisiti mancanti')}
          >
            {launching ? (
              <Loader size={15} className="animate-spin" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
            {report?.canLaunch ? 'Avvia Skyrim AE' : 'Avvio bloccato'}
          </button>
        </div>
      </div>
    </>
  )
}
