import { useEffect, useState, useCallback, useMemo } from 'react'
import { GripVertical, Save, Loader2, Lock } from 'lucide-react'
import { clsx } from 'clsx'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { toast } from '@/lib/toast'
import type { LoadOrderEntry, SaveLoadOrderResult } from '@/types'

// v1.1.0 "Conflict & Load Order" — Milestone 2 (interactive). Drag to reorder,
// checkboxes to enable/disable, and "Salva Ordine" writes back via
// window.api.plugin.saveOrder(). Base masters are pinned at the top: never
// draggable, never disable-able, always active and at the lowest indices — the
// game engine requires it.

// Skyrim SE base masters (lowercased). Kept in sync with pluginManager.ts.
const BASE_MASTERS = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'])
const isMaster = (name: string) => BASE_MASTERS.has(name.toLowerCase())

const reindex = (list: LoadOrderEntry[]): LoadOrderEntry[] => list.map((e, index) => ({ ...e, index }))

/** Normalize an incoming order: masters first (forced active), then the rest, reindexed. */
function normalize(entries: LoadOrderEntry[]): LoadOrderEntry[] {
  const masters = entries.filter((e) => isMaster(e.name)).map((e) => ({ ...e, active: true }))
  const rest = entries.filter((e) => !isMaster(e.name))
  return reindex([...masters, ...rest])
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: LoadOrderEntry[] }

export function LoadOrderPanel() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [saving, setSaving] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const api = window.api?.plugin
      if (!api?.getOrder) throw new Error('Load order non disponibile (backend non collegato)')
      const entries = await api.getOrder()
      setState({ status: 'ready', entries: normalize(entries) })
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const entries = useMemo(() => (state.status === 'ready' ? state.entries : []), [state])
  const masters = useMemo(() => entries.filter((e) => isMaster(e.name)), [entries])
  const rest = useMemo(() => entries.filter((e) => !isMaster(e.name)), [entries])
  const activeCount = entries.filter((e) => e.active).length

  const toggle = useCallback((name: string) => {
    if (isMaster(name)) return // masters are always active
    setState((prev) =>
      prev.status === 'ready'
        ? {
            status: 'ready',
            entries: prev.entries.map((e) => (e.name === name ? { ...e, active: !e.active } : e)),
          }
        : prev,
    )
  }, [])

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setState((prev) => {
      if (prev.status !== 'ready') return prev
      const m = prev.entries.filter((x) => isMaster(x.name))
      const r = prev.entries.filter((x) => !isMaster(x.name))
      const oi = r.findIndex((x) => x.name === active.id)
      const ni = r.findIndex((x) => x.name === over.id)
      if (oi < 0 || ni < 0) return prev
      // Masters stay pinned at the top; only the non-master slice reorders.
      return { status: 'ready', entries: reindex([...m, ...arrayMove(r, oi, ni)]) }
    })
  }, [])

  const save = useCallback(async () => {
    if (state.status !== 'ready') return
    setSaving(true)
    try {
      const res: SaveLoadOrderResult = await window.api.plugin.saveOrder(state.entries)
      if (res.success) {
        toast.success(
          'Load order salvato',
          `${res.written} plugin scritti${res.backupPath ? ' · backup creato' : ''}`,
        )
      } else {
        toast.error('Salvataggio fallito', res.error ?? 'Errore sconosciuto dal backend')
      }
    } catch (e) {
      // saveOrder never rejects in practice, but guard so a broken bridge can't crash the UI.
      toast.error('Salvataggio fallito', e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [state])

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
  if (entries.length === 0) {
    return (
      <div className="p-4 text-sm text-dark-400">
        Nessun plugin trovato. Se non hai ancora avviato Skyrim almeno una volta, il file plugins.txt non esiste
        ancora (lo crea il gioco al primo avvio).
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-dark-800 flex-shrink-0">
        <div className="text-xs text-dark-400">
          {entries.length} plugin · <span className="text-green-400">{activeCount} attivi</span> ·{' '}
          <span className="text-dark-500">{masters.length} master bloccati</span>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className={clsx(
            'flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold text-white transition-all',
            saving ? 'cursor-wait opacity-80' : 'hover:scale-[1.03]',
          )}
          style={{ background: 'linear-gradient(135deg, #7d4dff, #4d7dff)', boxShadow: '0 0 16px rgba(125,77,255,0.25)' }}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Salvataggio…' : 'Salva Ordine'}
        </button>
      </div>

      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-dark-500 uppercase tracking-wide border-b border-dark-800 flex-shrink-0">
        <div className="w-4" />
        <div className="w-8 text-center">#</div>
        <div className="w-12 text-center">Attivo</div>
        <div className="flex-1">Plugin</div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {/* Base masters — locked, always on top */}
        {masters.map((e) => (
          <LockedMasterRow key={e.name} entry={e} />
        ))}

        {/* Sortable, toggleable plugins */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rest.map((e) => e.name)} strategy={verticalListSortingStrategy}>
            {rest.map((e) => (
              <SortableLoadOrderRow key={e.name} entry={e} onToggle={() => toggle(e.name)} />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}

function LockedMasterRow({ entry }: { entry: LoadOrderEntry }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-dark-900/50 text-sm bg-soul-900/5">
      <div className="w-4 flex justify-center text-dark-700">
        <Lock size={12} />
      </div>
      <div className="w-8 text-center font-mono text-xs text-dark-500">
        {entry.index.toString(16).toUpperCase().padStart(2, '0')}
      </div>
      <div className="w-12 flex justify-center">
        <input
          type="checkbox"
          checked
          disabled
          readOnly
          className="accent-soul-500 cursor-not-allowed opacity-60"
          aria-label={`${entry.name} (master base, sempre attivo)`}
          title="Master base del gioco — sempre attivo, non riordinabile"
        />
      </div>
      <div className="flex-1 min-w-0 font-mono text-xs text-soul-300/90 truncate">{entry.name}</div>
    </div>
  )
}

function SortableLoadOrderRow({ entry, onToggle }: { entry: LoadOrderEntry; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.name })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        'flex items-center gap-2 px-3 py-2 border-b border-dark-900/50 text-sm transition-colors',
        entry.active ? 'hover:bg-white/5' : 'opacity-40 hover:opacity-60',
        isDragging && 'opacity-70 shadow-xl bg-dark-800',
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="w-4 flex justify-center text-dark-600 hover:text-dark-300 cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </div>
      <div className="w-8 text-center font-mono text-xs text-dark-500">
        {entry.index.toString(16).toUpperCase().padStart(2, '0')}
      </div>
      <div className="w-12 flex justify-center">
        <input
          type="checkbox"
          checked={entry.active}
          onChange={onToggle}
          className="accent-void-500 cursor-pointer"
          aria-label={`${entry.active ? 'Disattiva' : 'Attiva'} ${entry.name}`}
        />
      </div>
      <div
        className={clsx('flex-1 min-w-0 font-mono text-xs truncate', entry.active ? 'text-white/85' : 'text-dark-500')}
      >
        {entry.name}
      </div>
    </div>
  )
}
