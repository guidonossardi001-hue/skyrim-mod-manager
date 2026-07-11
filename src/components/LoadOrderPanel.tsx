import { useEffect, useState, useCallback } from 'react'
import type { LoadOrderEntry } from '@/types'

// v1.1.0 "Conflict & Load Order" — step 1: visibility. Reads the effective load
// order Skyrim uses (real plugins.txt + Data scan) via window.api.plugin.getOrder()
// and renders it as a simple table. The checkbox reflects the active flag; toggling
// updates local state only — persisting the change back to plugins.txt is a later
// step of this system, not part of the visibility pass.

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: LoadOrderEntry[] }

export function LoadOrderPanel() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const api = window.api?.plugin
      if (!api?.getOrder) throw new Error('Load order non disponibile (backend non collegato)')
      const entries = await api.getOrder()
      setState({ status: 'ready', entries })
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback((index: number) => {
    setState((prev) =>
      prev.status === 'ready'
        ? {
            status: 'ready',
            entries: prev.entries.map((e) => (e.index === index ? { ...e, active: !e.active } : e)),
          }
        : prev,
    )
  }, [])

  if (state.status === 'loading') {
    return <div className="p-4 text-sm text-dark-400">Lettura load order…</div>
  }
  if (state.status === 'error') {
    return (
      <div className="p-4 text-sm text-red-300">
        Errore: {state.message}
        <button onClick={() => void load()} className="ml-3 text-xs text-void-300 hover:underline">
          Riprova
        </button>
      </div>
    )
  }
  if (state.entries.length === 0) {
    return (
      <div className="p-4 text-sm text-dark-400">
        Nessun plugin trovato. Se non hai ancora avviato Skyrim almeno una volta, il file plugins.txt non esiste
        ancora (lo crea il gioco al primo avvio).
      </div>
    )
  }

  const activeCount = state.entries.filter((e) => e.active).length

  return (
    <div className="p-2">
      <div className="mb-2 px-2 text-xs text-dark-400">
        {state.entries.length} plugin · <span className="text-green-400">{activeCount} attivi</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-dark-500 border-b border-dark-800">
            <th className="py-2 px-2 w-12">#</th>
            <th className="py-2 px-2 w-16">Attivo</th>
            <th className="py-2 px-2">Plugin</th>
          </tr>
        </thead>
        <tbody>
          {state.entries.map((e) => (
            <tr key={e.name} className="border-b border-dark-800/50 hover:bg-white/5">
              <td className="py-1.5 px-2 font-mono text-xs text-dark-500">{e.index}</td>
              <td className="py-1.5 px-2">
                <input
                  type="checkbox"
                  checked={e.active}
                  onChange={() => toggle(e.index)}
                  className="accent-void-500"
                  aria-label={`${e.active ? 'Disattiva' : 'Attiva'} ${e.name}`}
                />
              </td>
              <td className="py-1.5 px-2 text-white/85 font-mono text-xs">{e.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
