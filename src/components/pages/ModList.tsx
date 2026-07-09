import { useState, useMemo, useEffect, useCallback, memo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import {
  Search,
  ChevronUp,
  ChevronDown,
  Power,
  Trash2,
  ExternalLink,
  AlertTriangle,
  Check,
  Package,
  GripVertical,
  ArrowUpCircle,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import type { Mod, ModCategory } from '@/types'
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
import { toast } from '@/components/ui/Toast'
import { ModDetailPanel } from '@/components/ui/ModDetailPanel'

const CATEGORY_LABELS: Record<ModCategory, string> = {
  framework: 'Framework',
  visuals: 'Grafica',
  character: 'Personaggio',
  npc: 'NPC',
  gameplay: 'Gameplay',
  combat: 'Combattimento',
  animation: 'Animazione',
  audio: 'Audio',
  quest: 'Quest',
  world: 'Mondo',
  lore: 'Lore',
  ui: 'Interfaccia',
  performance: 'Prestazioni',
  adult: 'Adulti',
  translation: 'Traduzione',
  patch: 'Patch',
  tool: 'Strumento',
  other: 'Altro',
}

type SortKey = 'name' | 'category' | 'priority' | 'file_size'

export default function ModList() {
  // Selettore shallow: la pagina reagisce solo ai campi che usa davvero.
  const { mods, conflicts, toggleMod, deleteMod, reorderMods, modListFilter } = useAppStore(
    useShallow((s) => ({
      mods: s.mods,
      conflicts: s.conflicts,
      toggleMod: s.toggleMod,
      deleteMod: s.deleteMod,
      reorderMods: s.reorderMods,
      modListFilter: s.modListFilter,
    })),
  )
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState<ModCategory | ''>((modListFilter as ModCategory) || '')

  // Sync the category filter when navigating here from a sidebar category shortcut.
  useEffect(() => {
    setFilterCategory((modListFilter as ModCategory) || '')
  }, [modListFilter])
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('priority')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [detailMod, setDetailMod] = useState<Mod | null>(null)
  const [groupByCategory, setGroupByCategory] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroup = (cat: string) =>
    setCollapsedGroups((prev) => {
      const s = new Set(prev)
      s.has(cat) ? s.delete(cat) : s.add(cat)
      return s
    })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Lookup O(1) per riga: sostituisce il conflicts.find(...) che ogni riga
  // pagava a ogni render (O(righe × conflitti)).
  const conflictById = useMemo(() => new Map(conflicts.map((c) => [c.modId, c])), [conflicts])

  const filtered = useMemo(() => {
    let result = [...mods]
    if (search) {
      const s = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(s) ||
          m.author?.toLowerCase().includes(s) ||
          m.category.toLowerCase().includes(s),
      )
    }
    if (filterCategory) result = result.filter((m) => m.category === filterCategory)
    if (filterEnabled === 'enabled') result = result.filter((m) => m.is_enabled)
    if (filterEnabled === 'disabled') result = result.filter((m) => !m.is_enabled)

    result.sort((a, b) => {
      let va: string | number = a[sortKey] ?? 0
      let vb: string | number = b[sortKey] ?? 0
      if (typeof va === 'string') va = va.toLowerCase()
      if (typeof vb === 'string') vb = vb.toLowerCase()
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
    return result
  }, [mods, search, filterCategory, filterEnabled, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // Handler stabili condivisi da tutte le righe: con React.memo su ModRow un
  // tick di stato ri-renderizza solo le righe le cui prop sono cambiate.
  const rowHandlers: RowHandlers = useMemo(
    () => ({
      onToggle: (mod) => {
        toggleMod(mod.id, !mod.is_enabled)
        toast.success(mod.is_enabled ? 'Mod disattivata' : 'Mod attivata', mod.name)
      },
      onSelect: (mod) => toggleSelect(mod.id),
      onDelete: (mod) => {
        deleteMod(mod.id)
        toast.error('Mod rimossa', mod.name)
      },
      onDetail: (mod) => setDetailMod(mod),
    }),
    [toggleMod, deleteMod, toggleSelect],
  )

  const totalSize = useMemo(() => mods.reduce((acc, m) => acc + m.file_size, 0) / 1024 / 1024 / 1024, [mods])

  // Drag-reorder only makes sense in the "natural" priority view: when a sort,
  // search, filter or grouping is active, the visible order ≠ stored priority,
  // so dragging would assign wrong priorities. We gate DnD on that condition.
  const canReorder =
    sortKey === 'priority' &&
    sortDir === 'asc' &&
    !search &&
    !filterCategory &&
    filterEnabled === 'all' &&
    !groupByCategory

  const sortableIds = useMemo(() => filtered.map((m) => m.id), [filtered])

  // Vista raggruppata appiattita (header + righe) per la lista virtuale.
  type GroupItem = { type: 'header'; cat: string; count: number } | { type: 'row'; mod: Mod; index: number }
  const groupedItems = useMemo<GroupItem[] | null>(() => {
    if (!groupByCategory) return null
    const groups = filtered.reduce<Record<string, Mod[]>>((acc, m) => {
      const k = m.category
      ;(acc[k] ??= []).push(m)
      return acc
    }, {})
    const items: GroupItem[] = []
    for (const [cat, catMods] of Object.entries(groups)) {
      items.push({ type: 'header', cat, count: catMods.length })
      if (!collapsedGroups.has(cat)) catMods.forEach((mod, index) => items.push({ type: 'row', mod, index }))
    }
    return items
  }, [groupByCategory, filtered, collapsedGroups])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    // Indices computed from `filtered` (what the user sees). canReorder guarantees
    // `filtered` is the full mod set in priority order, so this stays consistent.
    const oldIndex = filtered.findIndex((m) => m.id === active.id)
    const newIndex = filtered.findIndex((m) => m.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove([...filtered], oldIndex, newIndex)
    reorderMods(reordered.map((m, i) => ({ id: m.id, priority: i })))
    toast.success('Ordine aggiornato', `${filtered[oldIndex].name} → posizione ${newIndex + 1}`)
  }

  // Bulk: attende davvero le IPC (niente più successo dichiarato a operazioni in
  // volo) e riporta gli errori invece di silenziarli.
  const bulkSetEnabled = async (enabled: boolean) => {
    const ids = [...selected]
    setSelected(new Set())
    const results = await Promise.allSettled(ids.map((id) => toggleMod(id, enabled)))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) toast.warning('Aggiornamento parziale', `${ids.length - failed} ok, ${failed} falliti`)
    else toast.success(enabled ? 'Mod attivate' : 'Mod disattivate', `${ids.length} mod aggiornate`)
  }

  const bulkDelete = async () => {
    const ids = [...selected]
    if (!confirm(`Eliminare ${ids.length} mod selezionate dal profilo?`)) return
    setSelected(new Set())
    const results = await Promise.allSettled(ids.map((id) => deleteMod(id)))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) toast.warning('Eliminazione parziale', `${ids.length - failed} rimosse, ${failed} fallite`)
    else toast.error('Mod rimosse', `${ids.length} mod eliminate`)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="p-4 border-b border-dark-800 space-y-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold gradient-text-void" style={{ fontFamily: 'Cinzel, serif' }}>
            Lista Mod
          </h1>
          <div className="flex items-center gap-2 text-xs text-dark-400">
            <span>
              {mods.filter((m) => m.is_enabled).length}/{mods.length} attive
            </span>
            <span>·</span>
            <span>{totalSize.toFixed(1)} GB</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca mod, autore, categoria..."
              className="input-field pl-9"
            />
          </div>

          {/* Category filter */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as ModCategory | '')}
            className="input-field w-44"
          >
            <option value="">Tutte le categorie</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          {/* Enabled filter */}
          <select
            value={filterEnabled}
            onChange={(e) => setFilterEnabled(e.target.value as typeof filterEnabled)}
            className="input-field w-36"
          >
            <option value="all">Tutte</option>
            <option value="enabled">Attive</option>
            <option value="disabled">Disattive</option>
          </select>

          {/* Group toggle */}
          <button
            onClick={() => setGroupByCategory((v) => !v)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs transition-all border',
              groupByCategory
                ? 'bg-void-900/50 text-void-300 border-void-700/60'
                : 'text-dark-400 border-dark-700 hover:text-white',
            )}
          >
            Raggruppa
          </button>
        </div>
      </div>

      {/* Table header */}
      <div
        className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-dark-400 uppercase tracking-wide
        border-b border-dark-800 flex-shrink-0"
      >
        <div className="w-4" />
        <div className="w-6" />
        <div className="w-8" />
        <SortHeader
          label="Nome"
          sortKey="name"
          current={sortKey}
          dir={sortDir}
          onClick={toggleSort}
          className="flex-1"
        />
        <SortHeader
          label="Categoria"
          sortKey="category"
          current={sortKey}
          dir={sortDir}
          onClick={toggleSort}
          className="w-32"
        />
        <SortHeader
          label="Priorità"
          sortKey="priority"
          current={sortKey}
          dir={sortDir}
          onClick={toggleSort}
          className="w-20 text-center"
        />
        <SortHeader
          label="Dimensione"
          sortKey="file_size"
          current={sortKey}
          dir={sortDir}
          onClick={toggleSort}
          className="w-24 text-right"
        />
        <div className="w-16 text-center">IT</div>
        <div className="w-20 text-center">Azioni</div>
      </div>

      {/* Table body — TUTTE le viste sono virtualizzate: alla scala target
          (~4.500 mod) un .map piano monta decine di migliaia di nodi DOM. */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-dark-400">
          <Package size={40} className="mb-3 opacity-30" />
          <p className="text-sm">Nessuna mod trovata</p>
          <p className="text-xs mt-1 opacity-60">Vai al Catalogo per aggiungere mod</p>
        </div>
      ) : groupByCategory ? (
        // Vista raggruppata: header + righe appiattiti in un'unica lista virtuale.
        <div className="flex-1 min-h-0 w-full">
          <Virtuoso
            style={{ height: '100%', width: '100%' }}
            data={groupedItems!}
            computeItemKey={(_i, item) => (item.type === 'header' ? `h:${item.cat}` : item.mod.id)}
            itemContent={(_i, item) =>
              item.type === 'header' ? (
                <button
                  onClick={() => toggleGroup(item.cat)}
                  className="w-full flex items-center gap-2 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-dark-400 hover:text-white bg-dark-900/60 border-b border-dark-800 transition-colors"
                >
                  <ChevronDown
                    size={12}
                    className={clsx('transition-transform', collapsedGroups.has(item.cat) && '-rotate-90')}
                  />
                  {CATEGORY_LABELS[item.cat as ModCategory] ?? item.cat}
                  <span className="ml-auto text-dark-600">{item.count}</span>
                </button>
              ) : (
                <ModRow
                  mod={item.mod}
                  index={item.index}
                  draggable={false}
                  selected={selected.has(item.mod.id)}
                  hasConflict={conflictById.has(item.mod.id)}
                  conflict={conflictById.get(item.mod.id)}
                  handlers={rowHandlers}
                />
              )
            }
          />
        </div>
      ) : canReorder ? (
        // Vista riordinabile virtualizzata: SortableContext riceve TUTTI gli id
        // (l'ordine logico completo), Virtuoso monta solo le righe visibili.
        <div className="flex-1 min-h-0 w-full">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <Virtuoso
                style={{ height: '100%', width: '100%' }}
                data={filtered}
                initialItemCount={Math.min(filtered.length, 20)}
                computeItemKey={(_i, mod) => mod.id}
                itemContent={(idx, mod) => (
                  <SortableModRow
                    mod={mod}
                    index={idx}
                    selected={selected.has(mod.id)}
                    hasConflict={conflictById.has(mod.id)}
                    conflict={conflictById.get(mod.id)}
                    handlers={rowHandlers}
                  />
                )}
              />
            </SortableContext>
          </DndContext>
        </div>
      ) : (
        // Filtered/sorted view (no DnD): virtualized so thousands of mods stay smooth.
        <div className="flex-1 min-h-0 w-full">
          <Virtuoso
            style={{ height: '100%', width: '100%' }}
            data={filtered}
            initialItemCount={Math.min(filtered.length, 20)}
            computeItemKey={(_i, mod) => mod.id}
            itemContent={(idx, mod) => (
              <ModRow
                mod={mod}
                index={idx}
                draggable={false}
                selected={selected.has(mod.id)}
                hasConflict={conflictById.has(mod.id)}
                conflict={conflictById.get(mod.id)}
                handlers={rowHandlers}
              />
            )}
          />
        </div>
      )}

      <ModDetailPanel mod={detailMod} onClose={() => setDetailMod(null)} />

      {/* Status bar */}
      <div className="px-4 py-2 border-t border-dark-800 flex items-center justify-between text-xs text-dark-400 flex-shrink-0">
        <span>
          {filtered.length} mod mostrate
          {!canReorder && ' · riordino disattivato (rimuovi filtri/ordina per priorità)'}
        </span>
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span>{selected.size} selezionate</span>
            <button onClick={() => bulkSetEnabled(true)} className="text-green-400 hover:text-green-300">
              Attiva
            </button>
            <span className="text-dark-700">·</span>
            <button onClick={() => bulkSetEnabled(false)} className="text-orange-400 hover:text-orange-300">
              Disattiva
            </button>
            <span className="text-dark-700">·</span>
            <button onClick={bulkDelete} className="text-red-400 hover:text-red-300">
              Elimina selezionate
            </button>
            <span className="text-dark-700">·</span>
            <button onClick={() => setSelected(new Set())} className="text-dark-400 hover:text-white">
              Deseleziona
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// Handler condivisi e stabili (via useMemo nel padre): ogni riga li invoca con la
// PROPRIA mod, così React.memo può saltare le righe le cui prop non cambiano.
type RowHandlers = {
  onToggle: (mod: Mod) => void
  onSelect: (mod: Mod) => void
  onDelete: (mod: Mod) => void
  onDetail: (mod: Mod) => void
}

type ModRowProps = {
  mod: Mod
  index: number
  selected: boolean
  hasConflict: boolean
  conflict?: { severity: string; message: string }
  handlers: RowHandlers
  dragHandleProps?: Record<string, unknown>
  draggable?: boolean
}

function SortableModRow(props: ModRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.mod.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-70 shadow-2xl' : ''}>
      <ModRow {...props} draggable dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

const ModRow = memo(function ModRow({
  mod,
  selected,
  hasConflict,
  conflict,
  handlers,
  dragHandleProps,
  draggable = true,
}: ModRowProps) {
  const { onToggle, onSelect, onDelete, onDetail } = handlers
  const sizeMB = mod.file_size / 1024 / 1024
  // Version drift flagged by the delta engine (checkUpdates / Aggiornamenti).
  const update = useAppStore((s) => s.modUpdates[mod.id])

  return (
    <div
      className={clsx(
        'flex items-center gap-2 px-4 py-2 text-sm border-b border-dark-900/50 transition-colors',
        mod.is_enabled ? 'hover:bg-white/3' : 'opacity-50 hover:bg-white/2',
        selected && 'bg-void-900/30',
        hasConflict && 'bg-orange-900/10',
      )}
    >
      {/* Drag handle (only in reorderable view) */}
      {draggable ? (
        <div
          {...(dragHandleProps ?? {})}
          title="Trascina per riordinare"
          className="text-dark-600 hover:text-dark-400 cursor-grab active:cursor-grabbing transition-colors flex-shrink-0"
        >
          <GripVertical size={14} />
        </div>
      ) : (
        <div
          className="w-[14px] flex-shrink-0"
          title="Riordino disponibile solo con ordinamento per priorità, senza filtri"
        >
          <GripVertical size={14} className="text-dark-800" />
        </div>
      )}

      {/* Checkbox */}
      <div
        onClick={() => onSelect(mod)}
        className={clsx(
          'w-4 h-4 rounded border cursor-pointer flex items-center justify-center transition-all',
          selected ? 'bg-void-500 border-void-500' : 'border-dark-600 hover:border-dark-400',
        )}
      >
        {selected && <Check size={10} className="text-white" />}
      </div>

      {/* Priority badge */}
      <div className="w-6 h-6 rounded flex items-center justify-center text-xs font-mono text-dark-400">
        {mod.priority + 1}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDetail(mod)}
            className={clsx(
              'font-medium truncate text-left hover:underline underline-offset-2 transition-colors',
              mod.is_enabled ? 'text-white/90 hover:text-void-300' : 'text-dark-400 hover:text-dark-300',
            )}
          >
            {mod.name}
          </button>
          {hasConflict && (
            <span title={conflict?.message}>
              <AlertTriangle
                size={12}
                className={conflict?.severity === 'error' ? 'text-red-400' : 'text-orange-400'}
              />
            </span>
          )}
          {update?.hasUpdate && (
            <span
              title={`Aggiornamento disponibile: ${mod.version ?? '?'} → ${update.latestVersion}`}
              className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-void-900/40 text-void-300 flex-shrink-0"
            >
              <ArrowUpCircle size={10} /> update disponibile
            </span>
          )}
        </div>
        {update?.hasUpdate ? (
          <span className="text-xs text-void-400/80 truncate">
            {mod.author ? `${mod.author} · ` : ''}
            {mod.version ?? '?'} → {update.latestVersion}
          </span>
        ) : (
          mod.author && <span className="text-xs text-dark-400 truncate">{mod.author}</span>
        )}
      </div>

      {/* Category */}
      <div className="w-32">
        <span className={clsx('tag', `tag-${mod.category}`)}>
          {CATEGORY_LABELS[mod.category as ModCategory] ?? mod.category}
        </span>
      </div>

      {/* Priority (1-based load order, consistent with the badge) */}
      <div className="w-20 text-center text-dark-400 font-mono text-xs">{mod.priority + 1}</div>

      {/* Size */}
      <div className="w-24 text-right text-xs text-dark-400 font-mono">
        {sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB.toFixed(0)} MB`}
      </div>

      {/* IT translation */}
      <div className="w-16 flex justify-center">
        {mod.translation_it ? (
          <span className="text-green-400 text-xs">IT ✓</span>
        ) : (
          <span className="text-dark-600 text-xs">—</span>
        )}
      </div>

      {/* Actions */}
      <div className="w-20 flex items-center justify-center gap-1">
        <button
          onClick={() => onToggle(mod)}
          title={mod.is_enabled ? 'Disattiva' : 'Attiva'}
          className={clsx(
            'w-7 h-7 rounded flex items-center justify-center transition-all',
            mod.is_enabled
              ? 'text-green-400 hover:bg-red-500/20 hover:text-red-400'
              : 'text-dark-400 hover:bg-green-500/20 hover:text-green-400',
          )}
        >
          <Power size={14} />
        </button>

        {mod.nexus_url && (
          <button
            onClick={() => window.api.fs.openExternal(mod.nexus_url!)}
            title="Apri su Nexus Mods"
            className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-soul-400 hover:bg-soul-900/30 transition-all"
          >
            <ExternalLink size={12} />
          </button>
        )}

        <button
          onClick={() => onDelete(mod)}
          title="Elimina"
          className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-red-400 hover:bg-red-900/30 transition-all"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
})

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onClick,
  className,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: 'asc' | 'desc'
  onClick: (k: SortKey) => void
  className?: string
}) {
  const active = current === sortKey
  return (
    <button
      onClick={() => onClick(sortKey)}
      className={clsx(
        'flex items-center gap-1 hover:text-white transition-colors cursor-pointer',
        active ? 'text-void-400' : '',
        className,
      )}
    >
      {label}
      {active ? dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : null}
    </button>
  )
}
