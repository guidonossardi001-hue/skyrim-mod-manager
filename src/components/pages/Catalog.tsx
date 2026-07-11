import { useState, useEffect, useMemo, useCallback, memo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import {
  Search,
  Package,
  Download,
  ExternalLink,
  CheckCircle,
  Loader,
  CheckSquare,
  Square,
  Boxes,
  RefreshCw,
  X,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import type { CatalogMod } from '@/types'
import { clsx } from 'clsx'
import { MODLIST_CATALOG } from '@/data/modlistCatalog'
import { toast } from '@/lib/toast'
import DependencyResolver from '@/components/ui/DependencyResolver'

const CATEGORY_LABELS: Record<string, string> = {
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

export default function Catalog() {
  const { catalog, loadCatalog, mods, activeProfileId } = useAppStore()
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [showRequired, setShowRequired] = useState(false)
  const [showItalian, setShowItalian] = useState(false)
  const [installing, setInstalling] = useState<Set<number>>(new Set())
  const [checkingAll, setCheckingAll] = useState(false)
  const [updatingCatalog, setUpdatingCatalog] = useState(false)
  const [importingVortex, setImportingVortex] = useState(false)
  // Multi-select for the dependency resolver. Kept as a stable Set reference across
  // renders (updated only on toggle) so the resolver drawer never resets spuriously.
  const [selectedNexusIds, setSelectedNexusIds] = useState<Set<number>>(new Set())
  const [resolverOpen, setResolverOpen] = useState(false)

  useEffect(() => {
    // Seed the bundled baseline when the DB has FEWER mods than the bundle ships — covers both an
    // empty DB and a STALE seed frozen at an older build's count (the old `=== 0` guard never
    // topped up when modlistCatalog.ts grew). INSERT OR REPLACE is idempotent by the UNIQUE
    // nexus_id, so this tops up to the full bundled set WITHOUT clobbering a richer remote-ingested
    // catalog (whose count exceeds the bundle, so this branch is skipped).
    const bundledCount = new Set(
      (MODLIST_CATALOG as { nexus_id?: number }[]).map((m) => m.nexus_id).filter((n) => n != null),
    ).size
    if (catalog.length < bundledCount) {
      window.api.catalog
        .seed(MODLIST_CATALOG as never[])
        .then(() => loadCatalog())
        .catch((e) => toast.error('Caricamento catalogo fallito', (e as Error).message))
    }
  }, [catalog.length, loadCatalog])

  // Everything already in the profile (installed OR queued) counts as "satisfied"
  // for the resolver so it neither re-adds nor re-plans it.
  const installedSet = useMemo(
    () => new Set(mods.map((m) => m.nexus_id).filter((x): x is number => typeof x === 'number')),
    [mods],
  )
  const catalogByNexus = useMemo(() => new Map(catalog.map((m) => [m.nexus_id, m])), [catalog])

  const filtered = useMemo(() => {
    let result = [...catalog]
    if (search) {
      const s = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(s) ||
          m.description?.toLowerCase().includes(s) ||
          m.author?.toLowerCase().includes(s),
      )
    }
    if (filterCategory) result = result.filter((m) => m.category === filterCategory)
    if (showRequired) result = result.filter((m) => m.required)
    if (showItalian) result = result.filter((m) => m.has_it_translation)
    return result
  }, [catalog, search, filterCategory, showRequired, showItalian])

  // Add one catalog mod: create the mod record (linked to its download), using the
  // catalog priority_order so the load order is meaningful instead of a flat 999.
  const addCatalogMod = useCallback(
    async (m: CatalogMod) => {
    if (!activeProfileId) return
    const created = await window.api.mods.add({
      profile_id: activeProfileId,
      nexus_id: m.nexus_id,
      name: m.name,
      author: m.author ?? undefined,
      category: m.category,
      description: m.description ?? undefined,
      file_size: m.size_mb * 1024 * 1024,
      is_enabled: 1,
      is_installed: 0,
      priority: m.priority_order,
      load_order: m.priority_order,
      tags: m.tags,
      conflicts: m.conflicts_with,
      requires: m.requires,
      translation_it: m.has_it_translation,
      nexus_url: m.nexus_id ? `https://www.nexusmods.com/skyrimspecialedition/mods/${m.nexus_id}` : null,
    })
    await window.api.downloads.add({
      mod_id: created?.id ?? null,
      profile_id: activeProfileId,
      nexus_id: m.nexus_id,
      name: m.name,
      url: m.nexus_id ? `https://www.nexusmods.com/skyrimspecialedition/mods/${m.nexus_id}` : null,
      total_size: m.size_mb * 1024 * 1024,
      downloaded_size: 0,
      status: 'pending',
    })
    },
    [activeProfileId],
  )

  // Esegue il piano di installazione (target + prerequisiti mancanti) SENZA
  // ricaricare la lista mod: il refresh è responsabilità del chiamante, così
  // l'installazione di massa lo paga una volta sola.
  //
  // Il grafo delle dipendenze è risolto in modo AUTORITATIVO dal backend
  // (`catalog:resolvePlan`): ordinamento topologico per nexus_id numerici sul
  // catalogo firmato. Il client non fa mai congetture sui `requires` (che nel
  // catalogo reale sono JSON numerici tipo "[123]", non nomi).
  const installPlanOf = useCallback(
    async (mod: CatalogMod, installed: Set<number>) => {
      const res = await window.api.catalog.resolvePlan([mod.nexus_id], Array.from(installed))
      if (!res.success || !res.plan) {
        throw new Error(res.errors?.join('; ') ?? 'Risoluzione dipendenze fallita')
      }
      for (const item of res.plan) {
        const full = catalogByNexus.get(item.nexus_id)
        if (full) await addCatalogMod(full)
      }
      return res.plan
    },
    [catalogByNexus, addCatalogMod],
  )

  const installMod = useCallback(
    async (mod: CatalogMod) => {
    if (!activeProfileId) return
    setInstalling((prev) => new Set(prev).add(mod.nexus_id))
    try {
      const plan = await installPlanOf(mod, installedSet)
      await useAppStore.getState().loadMods()
      const deps = plan.length - 1
      toast.success(
        'Mod aggiunta',
        deps > 0
          ? `${mod.name} + ${deps} dipendenz${deps === 1 ? 'a' : 'e'} in coda`
          : `${mod.name} in coda download`,
      )
    } catch {
      toast.error('Errore installazione', mod.name)
    } finally {
      setInstalling((prev) => {
        const s = new Set(prev)
        s.delete(mod.nexus_id)
        return s
      })
    }
    },
    [activeProfileId, installedSet, installPlanOf],
  )

  const toggleSelect = useCallback((nexusId: number) => {
    setSelectedNexusIds((prev) => {
      const s = new Set(prev)
      if (s.has(nexusId)) s.delete(nexusId)
      else s.add(nexusId)
      return s
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedNexusIds(new Set()), [])

  // onProceed: enqueue the resolved plan in ORDER (deps first), then clear + close.
  // Each addCatalogMod inserts a pending download → the InstallManager queue drains it.
  const handleProceed = useCallback(
    async (plan: { nexus_id: number }[]) => {
      if (!activeProfileId) return
      let added = 0
      for (const item of plan) {
        const m = catalogByNexus.get(item.nexus_id)
        if (m) {
          await addCatalogMod(m)
          added++
        }
      }
      await useAppStore.getState().loadMods()
      setSelectedNexusIds(new Set())
      setResolverOpen(false)
      toast.success('Coda aggiornata', `${added} mod aggiunte alla coda di installazione`)
    },
    [activeProfileId, catalogByNexus, addCatalogMod],
  )

  // Fetch + ingest the full signed reference catalog (4000+ mods). Distinct from
  // the bundled MODLIST_CATALOG seed (essential mods only) auto-loaded on first
  // mount: this replaces modlist_catalog wholesale with the remote signed set.
  // No-throw IPC boundary — always a CatalogIngestResult.
  const updateCatalog = async () => {
    setUpdatingCatalog(true)
    try {
      const res = await window.api.catalog.update()
      if (res.success) {
        await loadCatalog()
        toast.success(
          'Catalogo aggiornato',
          res.reused
            ? 'Catalogo già aggiornato all’ultima versione'
            : `${res.inserted ?? 0} mod ingerite (v${res.version ?? '?'})`,
        )
      } else {
        toast.error('Aggiornamento catalogo fallito', res.error ?? res.errorKind ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Aggiornamento catalogo fallito', (e as Error).message)
    } finally {
      setUpdatingCatalog(false)
    }
  }

  // Import the full de-duplicated modlist (~4568 mods) from the local Vortex backup into the
  // catalog. INSERT OR IGNORE main-side, so curated rows keep their rich metadata.
  const importVortex = async () => {
    setImportingVortex(true)
    try {
      const res = await window.api.catalog.importVortex()
      if (res.success) {
        await loadCatalog()
        toast.success(
          'Modlist importata',
          `${res.imported ?? 0} nuove mod dal backup Vortex (totale ${res.total ?? 0})`,
        )
      } else {
        toast.error('Import Vortex fallito', res.error ?? 'errore sconosciuto')
      }
    } catch (e) {
      toast.error('Import Vortex fallito', (e as Error).message)
    } finally {
      setImportingVortex(false)
    }
  }

  const installAllFiltered = async () => {
    const missing = filtered.filter((m) => !installedSet.has(m.nexus_id))
    if (missing.length === 0) {
      toast.info('Tutto installato', 'Nessuna mod mancante nel filtro corrente')
      return
    }
    setCheckingAll(true)
    let ok = 0,
      failed = 0
    try {
      // Un solo loadMods/detectConflicts alla fine invece di uno per mod: prima
      // l'installazione di N mod costava N ricarichi completi (O(n²) alla scala
      // del catalogo). Il Set locale evita di ri-aggiungere le dipendenze comuni.
      const installed = new Set<number>(installedSet)
      for (const mod of missing) {
        try {
          const plan = await installPlanOf(mod, installed)
          plan.forEach((item) => installed.add(item.nexus_id))
          ok++
        } catch {
          failed++
        }
      }
      await useAppStore.getState().loadMods()
    } finally {
      setCheckingAll(false)
    }
    if (failed) toast.warning('Installazione parziale', `${ok} mod aggiunte, ${failed} fallite`)
    else toast.success('Installazione completata', `${ok} mod aggiunte al profilo`)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-dark-800 space-y-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold gradient-text-soul" style={{ fontFamily: 'Cinzel, serif' }}>
            Catalogo Mod
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-dark-400">
              {filtered.length} / {catalog.length} mod
            </span>
            {selectedNexusIds.size > 0 && (
              <button
                onClick={() => setResolverOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all"
                title="Analizza le dipendenze delle mod selezionate"
              >
                <Boxes size={12} /> Risolvi dipendenze ({selectedNexusIds.size})
              </button>
            )}
            <button
              onClick={importVortex}
              disabled={importingVortex}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
              title="Importa la modlist completa (~4568 mod) dal backup Vortex locale"
            >
              {importingVortex ? (
                <>
                  <Loader size={12} className="animate-spin" /> Import...
                </>
              ) : (
                <>
                  <Boxes size={12} /> Importa modlist Vortex
                </>
              )}
            </button>
            <button
              onClick={updateCatalog}
              disabled={updatingCatalog}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-void-900/50 text-void-200 hover:bg-void-800/70 hover:text-white transition-all disabled:opacity-50"
              title="Scarica e ingerisci il catalogo firmato completo (4000+ mod)"
            >
              {updatingCatalog ? (
                <>
                  <Loader size={12} className="animate-spin" /> Aggiornamento...
                </>
              ) : (
                <>
                  <RefreshCw size={12} /> Aggiorna catalogo
                </>
              )}
            </button>
            <button
              onClick={installAllFiltered}
              disabled={checkingAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs btn-primary"
            >
              {checkingAll ? (
                <>
                  <Loader size={12} className="animate-spin" /> Installazione...
                </>
              ) : (
                <>
                  <Download size={12} /> Installa tutti i filtrati
                </>
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca nel catalogo (nome, autore, descrizione)..."
              className="input-field pl-9"
            />
          </div>

          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="input-field w-44"
          >
            <option value="">Tutte le categorie</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-xs text-dark-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showRequired}
              onChange={(e) => setShowRequired(e.target.checked)}
              className="rounded"
            />
            Solo essenziali
          </label>

          <label className="flex items-center gap-2 text-xs text-dark-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showItalian}
              onChange={(e) => setShowItalian(e.target.checked)}
              className="rounded"
            />
            Solo IT
          </label>
        </div>
      </div>

      {/* Grid (virtualized for scalability with large catalogs) */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-16 text-dark-400">
          <Search size={40} className="mb-3 opacity-30" />
          <p className="text-sm">Nessun risultato trovato</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 w-full">
          <Virtuoso
            style={{ height: '100%', width: '100%' }}
            data={filtered}
            initialItemCount={Math.min(filtered.length, 15)}
            computeItemKey={(_i, mod) => mod.id}
            itemContent={(_i, mod) => (
              <div className="px-4 pt-2 last:pb-4">
                <CatalogCard
                  mod={mod}
                  installed={installedSet.has(mod.nexus_id)}
                  isInstalling={installing.has(mod.nexus_id)}
                  selected={selectedNexusIds.has(mod.nexus_id)}
                  onInstall={installMod}
                  onToggleSelect={toggleSelect}
                />
              </div>
            )}
          />
        </div>
      )}

      {/* Dependency Resolver drawer (right-side panel; keeps catalog context) */}
      {resolverOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={() => setResolverOpen(false)} />
          <aside className="w-[440px] max-w-full h-full bg-dark-900 border-l border-dark-800 shadow-2xl flex flex-col animate-[slideIn_.2s_ease-out]">
            <div className="flex items-center justify-between p-4 border-b border-dark-800 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Boxes size={16} className="text-void-400" />
                <h2 className="text-sm font-semibold text-white/90">Risoluzione Dipendenze</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearSelection}
                  className="text-xs text-dark-400 hover:text-white transition-colors"
                >
                  Deseleziona
                </button>
                <button
                  onClick={() => setResolverOpen(false)}
                  className="w-7 h-7 rounded flex items-center justify-center text-dark-400 hover:text-white hover:bg-dark-800 transition-all"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <DependencyResolver
                selected={selectedNexusIds}
                installed={installedSet}
                onProceed={handleProceed}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

// Memoized so a selection toggle re-renders ONLY the toggled card (its `selected`
// prop flips) instead of the whole virtualized list. All callbacks passed in are
// stable (useCallback), and every other prop is a primitive, so the shallow compare
// holds for the untouched rows.
const CatalogCard = memo(function CatalogCard({
  mod,
  installed,
  isInstalling,
  selected,
  onInstall,
  onToggleSelect,
}: {
  mod: CatalogMod
  installed: boolean
  isInstalling: boolean
  selected: boolean
  onInstall: (mod: CatalogMod) => void
  onToggleSelect: (nexusId: number) => void
}) {
  const sizeMB = mod.size_mb
  const nexusUrl = `https://www.nexusmods.com/skyrimspecialedition/mods/${mod.nexus_id}`
  const tags = JSON.parse(mod.tags || '[]') as string[]

  return (
    <div
      className={clsx(
        'card-hover p-3 flex items-start gap-3',
        selected && 'border-void-500/60 bg-void-900/10',
        installed && !selected && 'border-green-900/40',
      )}
    >
      {/* Selection checkbox */}
      <button
        onClick={() => onToggleSelect(mod.nexus_id)}
        className={clsx(
          'flex-shrink-0 mt-0.5 transition-colors',
          selected ? 'text-void-400' : 'text-dark-500 hover:text-dark-300',
        )}
        title={selected ? 'Deseleziona' : 'Seleziona per la risoluzione dipendenze'}
      >
        {selected ? <CheckSquare size={18} /> : <Square size={18} />}
      </button>

      {/* Icon placeholder */}
      <div
        className="w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center"
        style={{ background: `linear-gradient(135deg, rgba(125,77,255,0.2), rgba(77,125,255,0.15))` }}
      >
        <Package size={20} className="text-void-400" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-white/90 text-sm">{mod.name}</span>
              {mod.required ? <span className="tag tag-framework text-[10px] px-1.5">ESSENZIALE</span> : null}
              {mod.has_it_translation ? (
                <span className="tag tag-performance text-[10px] px-1.5">IT</span>
              ) : null}
            </div>
            {mod.author && <p className="text-xs text-dark-400 mt-0.5">di {mod.author}</p>}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {sizeMB > 0 && (
              <span className="text-xs text-dark-400 font-mono">
                {sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`}
              </span>
            )}
            <span className={clsx('tag text-[10px]', `tag-${mod.category}`)}>
              {CATEGORY_LABELS[mod.category] ?? mod.category}
            </span>
          </div>
        </div>

        {mod.description && <p className="text-xs text-dark-400 mt-1 line-clamp-1">{mod.description}</p>}

        {tags.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {tags.slice(0, 5).map((tag) => (
              <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-dark-300">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {mod.nexus_id && (
          <button
            onClick={() => window.api.fs.openExternal(nexusUrl)}
            className="w-8 h-8 rounded flex items-center justify-center text-dark-400 hover:text-soul-400 hover:bg-soul-900/30 transition-all"
            title="Apri su Nexus Mods"
          >
            <ExternalLink size={14} />
          </button>
        )}
        {installed ? (
          <div className="flex items-center gap-1 text-xs text-green-400">
            <CheckCircle size={13} />
            <span>Installata</span>
          </div>
        ) : isInstalling ? (
          <div className="flex items-center gap-1 text-xs text-void-400">
            <Loader size={13} className="animate-spin" />
            <span>Aggiunta...</span>
          </div>
        ) : (
          <button
            onClick={() => onInstall(mod)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-void-900/40 text-void-300 hover:bg-void-800/60 hover:text-white transition-all"
            title="Installa mod"
          >
            <Download size={12} />
            Installa
          </button>
        )}
      </div>
    </div>
  )
})
