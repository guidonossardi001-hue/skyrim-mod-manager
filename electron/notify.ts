import { Notification, type BrowserWindow } from 'electron'

// Notifica OS nativa (gap Vortex): i toast in-app (src/lib/toast.ts) sono transienti e
// invisibili se la finestra è minimizzata/dietro altre — un problema reale per i due loop
// incustoditi da fino a 3h del launcher (grass cache precache, crash-watch post-lancio). Qui SI
// escala a notifica di sistema, ma SOLO quando la finestra non è a fuoco: se l'utente la sta
// guardando, il toast basta e una notifica OS in più sarebbe solo rumore.

export interface NotifyIo {
  isSupported: () => boolean
  show: (opts: { title: string; body: string }) => void
}

/** IO reale: wrapper minimo sulla Notification API di Electron. */
export const realNotifyIo: NotifyIo = {
  isSupported: () => Notification.isSupported(),
  show: (opts) => new Notification({ title: opts.title, body: opts.body }).show(),
}

/**
 * Nucleo puro e testabile: notifica solo se `focused` è false e il sistema supporta le
 * notifiche. Mai throw — un fallimento della notifica non deve mai interrompere il chiamante
 * (un crash rilevato o un precache terminato devono restare loggati/gestiti comunque).
 * Ritorna true se la notifica è stata mostrata (utile nei test).
 */
export function notifyIfUnfocused(
  focused: boolean,
  opts: { title: string; body: string },
  io: NotifyIo = realNotifyIo,
): boolean {
  if (focused) return false
  try {
    if (!io.isSupported()) return false
    io.show(opts)
    return true
  } catch {
    return false
  }
}

/** Comodo per il main process: legge `isFocused()` direttamente da una BrowserWindow (o
 *  assente/distrutta → mai a fuoco → notifica). Mai throw. */
export function notifyWindowIfUnfocused(
  win: BrowserWindow | null | undefined,
  opts: { title: string; body: string },
  io: NotifyIo = realNotifyIo,
): boolean {
  let focused = false
  try {
    focused = !!win && !win.isDestroyed() && win.isFocused()
  } catch {
    focused = false
  }
  return notifyIfUnfocused(focused, opts, io)
}
