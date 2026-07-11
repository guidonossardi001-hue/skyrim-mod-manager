import { useEffect, useState, useCallback, useMemo } from 'react'
import { ShieldAlert, Download, X, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'

// Global consent gate for nxm:// links. The main process never auto-downloads an nxm link:
// it holds each as a pending request and pings 'nxm:confirm-request'. This modal is the
// explicit, per-download user consent — the only thing that turns a link into a download.
// Rendered at App level so it appears over BOTH the launcher and the manager views.

interface PendingNxm {
  token: string
  game: string
  modId: number
  fileId: number
  hasKey: boolean
  name?: string
  receivedAt: number
}

interface NxmApi {
  nxm?: {
    listPending: () => Promise<PendingNxm[]>
    approve: (token: string) => Promise<{ ok: boolean; id?: number; error?: string }>
    reject: (token: string) => Promise<{ ok: boolean }>
  }
  on?: (ch: string, cb: (...a: unknown[]) => void) => ((...a: unknown[]) => void) | void
  off?: (ch: string, cb: unknown) => void
}

export function NxmConsentModal() {
  const api = useMemo(() => window.api as unknown as NxmApi, [])
  const [pending, setPending] = useState<PendingNxm[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!api?.nxm) return
    try {
      setPending(await api.nxm.listPending())
    } catch {
      /* transient — the next event refetches */
    }
  }, [api])

  useEffect(() => {
    refresh()
    if (!api?.on) return
    const w = api.on('nxm:confirm-request', () => refresh())
    return () => api.off?.('nxm:confirm-request', w)
  }, [api, refresh])

  const current = pending[0]

  const approve = useCallback(async () => {
    if (!current || !api?.nxm) return
    setBusy(true)
    try {
      const r = await api.nxm.approve(current.token)
      if (r.ok) toast.success('Download avviato', current.name ?? `Mod ${current.modId}`)
      else toast.error('Richiesta non valida', r.error ?? 'Impossibile avviare il download')
    } finally {
      setBusy(false)
      refresh()
    }
  }, [api, current, refresh])

  const reject = useCallback(async () => {
    if (!current || !api?.nxm) return
    setBusy(true)
    try {
      await api.nxm.reject(current.token)
    } finally {
      setBusy(false)
      refresh()
    }
  }, [api, current, refresh])

  if (!current) return null
  const queued = pending.length - 1

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(5,5,7,0.72)', backdropFilter: 'blur(6px)' }}
      onClick={() => !busy && reject()} // backdrop = default-deny
    >
      <div
        className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(255,255,255,0.09)', boxShadow: '0 20px 70px rgba(0,0,0,0.6)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <div
            className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(255,69,0,0.14)' }}
          >
            <ShieldAlert size={20} className="text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-white/95 font-semibold text-base">Conferma download da Nexus</h2>
            <p className="text-xs text-dark-400 mt-0.5">
              Un link esterno chiede di <span className="text-amber-300/90">scaricare e installare</span> un file.
              Approva solo se hai avviato tu questo download.
            </p>
          </div>
          <button
            onClick={reject}
            disabled={busy}
            className="flex-shrink-0 text-dark-500 hover:text-white/80 p-1 rounded-lg hover:bg-white/5"
            title="Annulla"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mx-5 mb-4 rounded-xl p-3" style={{ background: 'var(--bg-primary)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-white/90 text-sm font-medium truncate">{current.name ?? `Mod ${current.modId}`}</p>
          <p className="text-xs text-dark-400 font-mono mt-0.5">
            mod {current.modId} · file {current.fileId}
          </p>
          {current.hasKey && (
            <span className="inline-block mt-2 text-[10px] uppercase tracking-wide text-void-200/80 bg-void-500/15 rounded px-1.5 py-0.5">
              download non-premium
            </span>
          )}
        </div>

        {queued > 0 && (
          <p className="px-5 -mt-1 mb-3 text-xs text-dark-400">
            +{queued} altra{queued > 1 ? 'e' : ''} richiesta{queued > 1 ? 'e' : ''} in coda
          </p>
        )}

        <div className="flex gap-2 p-4 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={reject}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm text-white/80 bg-white/5 hover:bg-white/10 disabled:opacity-50"
          >
            Annulla
          </button>
          <button
            onClick={approve}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg,#ff4500,#ff6a2e)' }}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            Scarica e installa
          </button>
        </div>
      </div>
    </div>
  )
}
