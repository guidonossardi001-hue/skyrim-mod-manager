import { useState, useMemo, useEffect, useRef } from 'react'
import { useAppStore } from '@/store/appStore'
import { GripVertical, Search, AlertTriangle, Info } from 'lucide-react'
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
import { derivePluginsFromMods, type Plugin } from '@/lib/plugins'
import { LoadOrderPanel } from '@/components/LoadOrderPanel'

type PluginTab = 'loadorder' | 'derived'

const TYPE_COLORS = {
  ESM: 'text-soul-400 bg-soul-900/30',
  ESP: 'text-void-400 bg-void-900/30',
  ESL: 'text-green-400 bg-green-900/30',
}

export default function Plugins() {
  // Single-value selector (not the whole store): re-render only when `mods` changes,
  // consistent with the app's useShallow/selector convention on hot components.
  const mods = useAppStore((s) => s.mods)
  const [tab, setTab] = useState<PluginTab>('loadorder')
  const [search, setSearch] = useState('')
  const [plugins, setPlugins] = useState<Plugin[]>(() => derivePluginsFromMods(mods))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Re-derive plugins whenever the underlying mod set changes (install/remove,
  // enable/disable, profile switch), while preserving the user's manual
  // enable/disable and drag order for plugins that still exist.
  const prevToggles = useRef<Record<string, boolean>>({})
  useEffect(() => {
    setPlugins((prev) => {
      prev.forEach((p) => {
        prevToggles.current[p.id] = p.enabled
      })
      const order = new Map(prev.map((p, i) => [p.id, i]))
      const fresh = derivePluginsFromMods(mods).map((p) => ({
        ...p,
        enabled: p.isMaster ? true : (prevToggles.current[p.id] ?? p.enabled),
      }))
      fresh.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
      return fresh.map((p, i) => ({ ...p, loadIndex: i }))
    })
  }, [mods])

  const filtered = useMemo(() => {
    if (!search) return plugins
    const s = search.toLowerCase()
    return plugins.filter((p) => p.name.toLowerCase().includes(s) || p.modName.toLowerCase().includes(s))
  }, [plugins, search])

  const counts = useMemo(
    () => ({
      esm: plugins.filter((p) => p.type === 'ESM').length,
      esp: plugins.filter((p) => p.type === 'ESP').length,
      esl: plugins.filter((p) => p.type === 'ESL').length,
      enabled: plugins.filter((p) => p.enabled).length,
    }),
    [plugins],
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setPlugins((prev) => {
      const oi = prev.findIndex((p) => p.id === active.id)
      const ni = prev.findIndex((p) => p.id === over.id)
      const next = arrayMove(prev, oi, ni).map((p, i) => ({ ...p, loadIndex: i }))
      toast.success('Ordine plugin aggiornato')
      return next
    })
  }

  const togglePlugin = (id: string) => {
    setPlugins((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p
        if (p.isMaster) {
          toast.warning('Master non modificabile', 'I file ESM del gioco base non possono essere disattivati')
          return p
        }
        return { ...p, enabled: !p.enabled }
      }),
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-dark-800 space-y-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold gradient-text-soul" style={{ fontFamily: 'Cinzel, serif' }}>
            Plugin Manager
          </h1>
          {tab === 'derived' && (
            <div className="flex items-center gap-3 text-xs text-dark-400">
              <span className={TYPE_COLORS.ESM + ' px-2 py-0.5 rounded font-mono'}>{counts.esm} ESM</span>
              <span className={TYPE_COLORS.ESP + ' px-2 py-0.5 rounded font-mono'}>{counts.esp} ESP</span>
              <span className={TYPE_COLORS.ESL + ' px-2 py-0.5 rounded font-mono'}>{counts.esl} ESL</span>
              <span className="text-dark-500">·</span>
              <span>
                {counts.enabled}/{plugins.length} attivi
              </span>
            </div>
          )}
        </div>

        {/* Tabs: real game load order (plugins.txt) vs the mod-derived view */}
        <div className="flex items-center gap-1">
          {(
            [
              { id: 'loadorder', label: 'Load Order (reale)' },
              { id: 'derived', label: 'Vista derivata' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                'px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors',
                tab === t.id ? 'bg-soul-500/20 text-soul-300' : 'text-dark-400 hover:text-white/80 hover:bg-white/5',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'derived' && (
          <>
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cerca plugin o mod..."
                  className="input-field pl-9"
                />
              </div>
            </div>

            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-soul-900/10 border border-soul-500/20 text-xs text-soul-300">
              <Info size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                L'ordine di carico mostrato è derivato dalla lista mod. Per l'ordine definitivo usa LOOT dalla
                pagina Strumenti.
              </span>
            </div>
          </>
        )}
      </div>

      {tab === 'loadorder' ? (
        // Real effective load order (game plugins.txt + Data scan) — read-only.
        <div className="flex-1 overflow-y-auto">
          <LoadOrderPanel />
        </div>
      ) : (
        <>
          {/* Table header */}
          <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-dark-400 uppercase tracking-wide border-b border-dark-800 flex-shrink-0">
            <div className="w-4" />
            <div className="w-8 text-center">#</div>
            <div className="flex-1">Plugin</div>
            <div className="w-14 text-center">Tipo</div>
            <div className="w-40 hidden md:block">Mod</div>
            <div className="w-16 text-center">Stato</div>
          </div>

          {/* Plugin list */}
          <div className="flex-1 overflow-y-auto">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={filtered.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                {filtered.map((plugin) => (
                  <SortablePluginRow key={plugin.id} plugin={plugin} onToggle={() => togglePlugin(plugin.id)} />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-dark-800 text-xs text-dark-400 flex-shrink-0">
            {filtered.length} plugin · Trascina per riordinare
          </div>
        </>
      )}
    </div>
  )
}

function SortablePluginRow({ plugin, onToggle }: { plugin: Plugin; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: plugin.id,
  })
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
        'flex items-center gap-2 px-4 py-2 border-b border-dark-900/50 text-sm transition-colors',
        plugin.enabled ? 'hover:bg-white/3' : 'opacity-40 hover:opacity-60',
        plugin.isMaster && 'bg-soul-900/5',
        isDragging && 'opacity-70 shadow-xl',
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="text-dark-600 hover:text-dark-400 cursor-grab active:cursor-grabbing w-4"
      >
        <GripVertical size={14} />
      </div>

      <div className="w-8 text-center font-mono text-xs text-dark-500">
        {plugin.loadIndex.toString(16).toUpperCase().padStart(2, '0')}
      </div>

      <div className="flex-1 min-w-0">
        <span className={clsx('font-medium', plugin.enabled ? 'text-white/85' : 'text-dark-500')}>
          {plugin.name}
        </span>
        {plugin.hasWarning && <AlertTriangle size={12} className="inline ml-2 text-orange-400" />}
      </div>

      <div className="w-14 text-center">
        <span
          className={clsx('px-1.5 py-0.5 rounded text-xs font-mono font-semibold', TYPE_COLORS[plugin.type])}
        >
          {plugin.type}
        </span>
      </div>

      <div className="w-40 hidden md:block">
        <span className="text-xs text-dark-400 truncate block">{plugin.modName}</span>
      </div>

      <div className="w-16 flex justify-center">
        <button
          onClick={onToggle}
          disabled={plugin.isMaster}
          className={clsx(
            'text-xs px-2 py-0.5 rounded-full transition-all',
            plugin.enabled
              ? 'bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400'
              : 'bg-dark-700 text-dark-500 hover:bg-green-500/20 hover:text-green-400',
            plugin.isMaster && 'cursor-not-allowed opacity-50',
          )}
        >
          {plugin.enabled ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  )
}
