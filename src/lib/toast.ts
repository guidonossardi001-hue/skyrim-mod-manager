// Framework-agnostic toast emitter. Kept OUT of the Toast.tsx component file so that
// file exports only the ToastContainer component (React Fast Refresh requires a module
// to export components exclusively). Components call `toast(...)`; ToastContainer
// subscribes via subscribeToast to render them.

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
}

type Listener = (toast: Toast) => void
const listeners: Listener[] = []

/** Subscribe to emitted toasts; returns an unsubscribe function. */
export function subscribeToast(listener: Listener): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

export function toast(type: ToastType, title: string, message?: string, duration = 3500) {
  const t: Toast = { id: Math.random().toString(36).slice(2), type, title, message, duration }
  listeners.forEach((l) => l(t))
}
toast.success = (title: string, msg?: string) => toast('success', title, msg)
toast.error = (title: string, msg?: string) => toast('error', title, msg, 5000)
toast.warning = (title: string, msg?: string) => toast('warning', title, msg)
toast.info = (title: string, msg?: string) => toast('info', title, msg)
