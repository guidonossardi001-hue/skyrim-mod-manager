import { useEffect, useState, useCallback } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import { clsx } from 'clsx'
import { subscribeToast, type Toast } from '@/lib/toast'

const ICONS = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const COLORS = {
  success: { border: 'border-green-500/40', icon: 'text-green-400', bg: 'bg-green-500/10' },
  error: { border: 'border-red-500/40', icon: 'text-red-400', bg: 'bg-red-500/10' },
  warning: { border: 'border-orange-500/40', icon: 'text-orange-400', bg: 'bg-orange-500/10' },
  info: { border: 'border-void-500/40', icon: 'text-void-400', bg: 'bg-void-500/10' },
}

function ToastItem({ toast: t, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [visible, setVisible] = useState(false)
  const Icon = ICONS[t.type]
  const c = COLORS[t.type]

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(() => onRemove(t.id), 300)
    }, t.duration ?? 3500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={clsx(
        'flex items-start gap-3 p-3 rounded-xl border backdrop-blur-md shadow-xl transition-all duration-300 min-w-72 max-w-sm',
        c.border,
        c.bg,
        visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8',
      )}
      style={{ background: 'rgba(10,10,15,0.92)' }}
    >
      <Icon size={16} className={clsx('flex-shrink-0 mt-0.5', c.icon)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white/90">{t.title}</p>
        {t.message && <p className="text-xs text-dark-300 mt-0.5">{t.message}</p>}
      </div>
      <button
        onClick={() => {
          setVisible(false)
          setTimeout(() => onRemove(t.id), 300)
        }}
        className="text-dark-400 hover:text-white transition-colors flex-shrink-0"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const add = useCallback((t: Toast) => setToasts((prev) => [...prev, t]), [])
  const remove = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), [])

  useEffect(() => subscribeToast(add), [add])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onRemove={remove} />
        </div>
      ))}
    </div>
  )
}
