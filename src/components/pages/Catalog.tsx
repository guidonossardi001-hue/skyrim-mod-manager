import { useState, useEffect, useMemo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { Search, Plus, Package, Star, Download, ExternalLink, CheckCircle, Loader } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import type { CatalogMod } from '@/types'
import { clsx } from 'clsx'
import { MODLIST_CATALOG } from '@/data/modlistCatalog'
import { toast } from '@/components/ui/Toast'
import { resolveInstallPlan } from '@/lib/dependencies'

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
  const { catalog, loadCatalog, mods, activeProfileId, settings } = useAppStore()
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [showRequired, setShowRequired] = useState(false)
  const [showItalian, setShowItalian] = useState(false)
  const [installing, setInstalling] = useState<Set<number>>(new Set())
  const [checkingAll, setCheckingAll] = useState(false)

  useEffect(() => {
    if (catalog.length === 0) {
      window.api.catalog
        .seed(MODLIST_CATALOG as never[])
        .then(() => loadCatalog())
        .catch((e) => toast.error('Caricamento catalogo fallito', (e as Error).message))
    }
  }, [catalog.length])

  const installedIds = useMemo(() => new Set(mods.map((m) => m.nexus_id).filter(Boolean)), [mods])

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
  const addCatalogMod = async (m: CatalogMod) => {
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
  }

  // Esegue il piano di installazione (target + prerequisiti mancanti) SENZA
  // ricaricare la lista mod: il refresh è responsabilità del chiamante, così
  // l'installazione di massa lo paga una volta sola.
  const installPlanOf = async (mod: CatalogMod, installed: Set<number>) => {
    const plan = resolveInstallPlan(mod, catalog, installed)
    for (const item of plan) await addCatalogMod(item.mod)
    return plan
  }

  const installMod = async (mod: CatalogMod) => {
    if (!activeProfileId) return
    setInstalling((prev) => new Set(prev).add(mod.nexus_id))
    try {
      const plan = await installPlanOf(mod, installedIds as Set<number>)
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
  }

  const installAllFiltered = async () => {
    const missing = filtered.filter((m) => !installedIds.has(m.nexus_id))
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
      const installed = new Set<number>(installedIds as Set<number>)
      for (const mod of missing) {
        try {
          const plan = await installPlanOf(mod, installed)
          plan.forEach((item) => installed.add(item.mod.nexus_id))
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
                  installed={installedIds.has(mod.nexus_id)}
                  isInstalling={installing.has(mod.nexus_id)}
                  onInstall={() => installMod(mod)}
                />
              </div>
            )}
          />
        </div>
      )}
    </div>
  )
}

function CatalogCard({
  mod,
  installed,
  isInstalling,
  onInstall,
}: {
  mod: CatalogMod
  installed: boolean
  isInstalling: boolean
  onInstall: () => void
}) {
  const sizeMB = mod.size_mb
  const nexusUrl = `https://www.nexusmods.com/skyrimspecialedition/mods/${mod.nexus_id}`
  const tags = JSON.parse(mod.tags || '[]') as string[]

  return (
    <div className={clsx('card-hover p-3 flex items-start gap-3', installed && 'border-green-900/40')}>
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
            onClick={onInstall}
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
}
