import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  MinusCircle,
  Loader2,
  Flame,
  Settings2,
  RotateCcw,
  Link2,
  ShieldCheck,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '@/store/appStore'
import { toast } from '@/lib/toast'

// ── Types mirroring the main-process launch pipeline (electron/launch/activeLaunch) ──
interface LaunchProgress {
  index: number
  total: number
  stage: string
  label: string
  status: 'running' | 'ok' | 'warning' | 'fail' | 'skipped'
  detail: string
  fix?: string
}
interface ActiveLaunchResult {
  launched: boolean
  bootstrapperId: string | null
  bootstrapperName: string | null
  blockingStage: string | null
  message: string
  steps: LaunchProgress[]
}
interface SmartConfig {
  autoLaunch: boolean
  lastBootstrapperId: string | null
  lastLaunchAt: string | null
  launchCount: number
}
interface LauncherApi {
  launch: {
    activeRun: () => Promise<ActiveLaunchResult>
    onProgress: (cb: (p: LaunchProgress) => void) => () => void
  }
  launcher: {
    createAppShortcut: () => Promise<{ success: boolean; shortcutPath?: string; error?: string }>
    smartConfig: () => Promise<SmartConfig>
    setSmartConfig: (patch: Partial<SmartConfig>) => Promise<SmartConfig>
  }
  window?: { minimize?: () => Promise<void> }
  app?: { getVersion?: () => Promise<string> }
}

type Phase = 'idle' | 'launching' | 'done' | 'blocked'

const STATUS_ICON = {
  running: <Loader2 size={16} className="text-void-300 animate-spin" />,
  ok: <CheckCircle2 size={16} className="text-green-400" />,
  warning: <AlertTriangle size={16} className="text-amber-400" />,
  fail: <XCircle size={16} className="text-red-400" />,
  skipped: <MinusCircle size={16} className="text-dark-500" />,
}

export function LauncherShell() {
  const setLauncherActive = useAppStore((s) => s.setLauncherActive)
  const [phase, setPhase] = useState<Phase>('idle')
  const [steps, setSteps] = useState<LaunchProgress[]>([])
  const [result, setResult] = useState<ActiveLaunchResult | null>(null)
  const [smart, setSmart] = useState<SmartConfig | null>(null)
  const [version, setVersion] = useState<string>('')
  const autoTriggered = useRef(false)

  const api = useMemo(() => window.api as unknown as LauncherApi, [])
  const hasApi = typeof api?.launch?.activeRun === 'function'

  const play = useCallback(async () => {
    if (!hasApi) {
      toast.error('Avvio non disponibile', 'Il backend del launcher non è raggiungibile')
      return
    }
    setPhase('launching')
    setResult(null)
    setSteps([])
    // Stream stage progress: each stage arrives as 'running' then a terminal status.
    // Key by stage so the terminal event replaces the running placeholder in place.
    const unsub = api.launch.onProgress((p) => {
      setSteps((prev) => {
        const others = prev.filter((s) => s.stage !== p.stage)
        return [...others, p].sort((a, b) => a.index - b.index)
      })
    })
    try {
      const res = await api.launch.activeRun()
      setResult(res)
      setPhase(res.launched ? 'done' : 'blocked')
      if (res.launched) {
        toast.success('Avvio completato', `Gioco moddato avviato tramite ${res.bootstrapperName ?? 'bootstrapper'}`)
        // Hand off: get the launcher out of the way once the game is starting.
        setTimeout(() => api.window?.minimize?.(), 1600)
      } else {
        toast.error('Avvio interrotto', res.message)
      }
    } catch (e) {
      setPhase('blocked')
      setResult({
        launched: false,
        bootstrapperId: null,
        bootstrapperName: null,
        blockingStage: null,
        message: (e as Error).message,
        steps: [],
      })
    } finally {
      unsub?.()
    }
  }, [api, hasApi])

  // Load smart-startup config + version, then One-Click auto-launch if enabled.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const cfg = hasApi ? await api.launcher.smartConfig() : null
        if (alive) setSmart(cfg)
        const v = await api.app?.getVersion?.().catch(() => '')
        if (alive && v) setVersion(v)
        if (alive && cfg?.autoLaunch && !autoTriggered.current) {
          autoTriggered.current = true
          play()
        }
      } catch {
        /* config optional */
      }
    })()
    return () => {
      alive = false
    }
  }, [api, hasApi, play])

  const toggleAuto = async () => {
    if (!smart) return
    const next = { ...smart, autoLaunch: !smart.autoLaunch }
    setSmart(next)
    try {
      await api.launcher.setSmartConfig({ autoLaunch: next.autoLaunch })
      toast.success(
        next.autoLaunch ? 'Avvio automatico attivo' : 'Avvio automatico disattivato',
        next.autoLaunch ? 'Al prossimo avvio il gioco partirà da solo' : 'Dovrai premere GIOCA',
      )
    } catch {
      setSmart(smart) // revert on failure
    }
  }

  const makeShortcut = async () => {
    try {
      const r = await api.launcher.createAppShortcut()
      if (r.success) toast.success('Collegamento creato', 'Icona del launcher aggiunta al Desktop')
      else toast.error('Collegamento non creato', r.error ?? 'Errore sconosciuto')
    } catch (e) {
      toast.error('Collegamento non creato', (e as Error).message)
    }
  }

  const busy = phase === 'launching'

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, rgba(125,77,255,0.18), transparent 60%),' +
          'radial-gradient(900px 500px at 50% 120%, rgba(255,69,0,0.12), transparent 55%),' +
          'var(--bg-primary)',
      }}
    >
      <div className="flex-1 flex flex-col items-center px-6 overflow-y-auto">
        {/* Emblem + wordmark */}
        <div className="flex flex-col items-center mt-6 mb-8 text-center select-none">
          <div
            className="relative w-24 h-24 rounded-3xl flex items-center justify-center mb-5"
            style={{
              background: 'linear-gradient(135deg, #7d4dff, #4d7dff)',
              boxShadow: '0 0 60px rgba(125,77,255,0.45), inset 0 0 20px rgba(255,255,255,0.15)',
            }}
          >
            <Flame size={44} className="text-white drop-shadow" fill="currentColor" />
            <span
              className="absolute -bottom-2 -right-2 w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg font-bold"
              style={{ background: 'linear-gradient(135deg,#ff4500,#ff6a2e)', fontFamily: 'Cinzel, serif' }}
            >
              S
            </span>
          </div>
          <h1
            className="text-4xl font-bold tracking-wide text-white/95"
            style={{ fontFamily: 'Cinzel, serif', textShadow: '0 2px 30px rgba(125,77,255,0.5)' }}
          >
            SKYRIM AE
          </h1>
          <p className="text-sm text-void-200/80 mt-2 tracking-widest uppercase">Fantasy Edition · Versione Moddata</p>
        </div>

        {/* Play button */}
        <button
          onClick={play}
          disabled={busy || !hasApi}
          className={clsx(
            'group relative flex items-center justify-center gap-3 px-14 py-4 rounded-2xl font-bold text-lg transition-all',
            busy ? 'cursor-wait' : 'hover:scale-[1.03] active:scale-100',
          )}
          style={{
            background: busy ? 'rgba(255,255,255,0.06)' : 'linear-gradient(135deg, #ff4500, #ff6a2e)',
            color: busy ? 'rgba(255,255,255,0.7)' : '#fff',
            boxShadow: busy ? 'none' : '0 0 40px rgba(255,69,0,0.4)',
            fontFamily: 'Cinzel, serif',
          }}
        >
          {busy ? <Loader2 size={22} className="animate-spin" /> : <Play size={22} fill="currentColor" />}
          {busy ? 'AVVIO IN CORSO…' : 'GIOCA'}
        </button>
        {!hasApi && (
          <p className="text-xs text-amber-400/80 mt-3">Anteprima: backend del launcher non collegato</p>
        )}

        {/* Staged checklist (Nolvus-style) */}
        {(phase !== 'idle' || steps.length > 0) && (
          <div
            className="w-full max-w-xl mt-8 mb-4 rounded-2xl p-2"
            style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            {steps.map((s) => (
              <div key={s.stage} className="flex items-start gap-3 px-3 py-2.5 rounded-xl">
                <span className="mt-0.5 flex-shrink-0">{STATUS_ICON[s.status]}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/90">{s.label}</span>
                    <span className="text-[10px] text-dark-500 font-mono">
                      {s.index}/{s.total}
                    </span>
                  </div>
                  <p className="text-xs text-dark-400 truncate">{s.detail}</p>
                  {s.fix && (s.status === 'fail' || s.status === 'warning') && (
                    <p className="text-xs text-soul-300 mt-0.5">→ {s.fix}</p>
                  )}
                </div>
              </div>
            ))}

            {phase === 'blocked' && result && (
              <div className="m-2 p-3 rounded-xl bg-red-900/20 border border-red-500/20">
                <p className="text-sm text-red-300 font-semibold flex items-center gap-2">
                  <XCircle size={15} /> Avvio interrotto
                </p>
                <p className="text-xs text-red-200/80 mt-1">{result.message}</p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={play}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-white"
                    style={{ background: 'linear-gradient(135deg,#ff4500,#ff6a2e)' }}
                  >
                    <RotateCcw size={13} /> Riprova
                  </button>
                  <button
                    onClick={() => setLauncherActive(false)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-white/80 bg-white/5 hover:bg-white/10"
                  >
                    <Settings2 size={13} /> Apri Gestione Mod
                  </button>
                </div>
              </div>
            )}

            {phase === 'done' && result && (
              <div className="m-2 p-3 rounded-xl bg-green-900/15 border border-green-500/20">
                <p className="text-sm text-green-300 font-semibold flex items-center gap-2">
                  <ShieldCheck size={15} /> {result.message}
                </p>
                <p className="text-xs text-green-200/70 mt-1">
                  Avviato tramite {result.bootstrapperName}. Il launcher si riduce a icona.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer bar */}
      <div
        className="flex-shrink-0 flex items-center justify-between px-6 py-3 text-xs"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.25)' }}
      >
        <div className="flex items-center gap-4 text-dark-400">
          <span style={{ fontFamily: 'Cinzel, serif' }}>Fantasy Launcher{version ? ` · v${version}` : ''}</span>
          {smart && smart.launchCount > 0 && <span>· {smart.launchCount} avvii</span>}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer text-dark-300 hover:text-white/80 px-2 py-1.5 rounded-lg hover:bg-white/5">
            <input
              type="checkbox"
              checked={!!smart?.autoLaunch}
              onChange={toggleAuto}
              disabled={!smart}
              className="accent-void-500"
            />
            Avvio automatico
          </label>
          <button
            onClick={makeShortcut}
            title="Crea collegamento del launcher sul Desktop"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-dark-300 hover:text-white/90 hover:bg-white/5"
          >
            <Link2 size={14} /> Collegamento Desktop
          </button>
          <button
            onClick={() => setLauncherActive(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-void-200 hover:text-white bg-void-500/15 hover:bg-void-500/25"
          >
            <Settings2 size={14} /> Gestione Mod
          </button>
        </div>
      </div>
    </div>
  )
}
