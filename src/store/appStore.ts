import { create } from 'zustand'
import type { Profile, Mod, Download, AppSettings, CatalogMod, ConflictInfo } from '@/types'
import { parseMO2Modlist } from '@/lib/modlist'
import { detectExclusionConflicts } from '@/lib/exclusionGroups'

export interface LogLine {
  id: number
  time: string
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
}
export interface VortexStats {
  uniqueMods: number
  totalBytes: number
  collections: number
  duplicatesRemoved: number
}

interface AppStore {
  // State
  profiles: Profile[]
  activeProfileId: number | null
  mods: Mod[]
  downloads: Download[]
  catalog: CatalogMod[]
  settings: AppSettings
  conflicts: ConflictInfo[]
  isLoading: boolean
  loadingMessage: string
  sidebarCollapsed: boolean
  activePage: string
  // Launcher-first entry: when true the full-screen Fantasy Launcher (One-Click
  // Play) is shown instead of the mod-manager UI. Reset to true on every app start.
  launcherActive: boolean
  modListFilter: string // category preselected when navigating from the sidebar

  // Actions - profiles
  loadProfiles: () => Promise<void>
  createProfile: (name: string, description?: string) => Promise<void>
  setActiveProfile: (id: number) => void
  updateProfile: (id: number, data: Partial<Profile>) => Promise<void>
  deleteProfile: (id: number) => Promise<void>

  // Actions - mods
  loadMods: (profileId?: number) => Promise<void>
  toggleMod: (modId: number, enabled: boolean) => Promise<void>
  deleteMod: (modId: number) => Promise<void>
  reorderMods: (items: { id: number; priority: number }[]) => Promise<void>
  updateMod: (modId: number, data: Partial<Mod>) => Promise<void>
  // La API key non transita più dal renderer: gli handler Nexus la leggono
  // dal secret store del processo main.
  checkForUpdates: (modId: number) => Promise<{ hasUpdate: boolean; latestVersion?: string }>

  modUpdates: Record<number, { latestVersion: string; hasUpdate: boolean }>
  checkAllUpdates: () => Promise<{ checked: number; updates: number }>
  /** Map a delta changeset (changed rows) → modUpdates badges, keyed by mod id. Returns the count flagged. */
  markDriftFromChangeset: (
    rows: { nexus_id: number; to_version: string | null; change_type: string }[],
  ) => number
  resolveConflict: (modId: number, action: 'disable' | 'priority-top') => Promise<void>
  exportLoadOrder: () => { pluginsTxt: string; modlistTxt: string }
  importFromMO2: (modlistContent: string) => Promise<{ imported: number }>

  // Actions - catalog
  loadCatalog: (filter?: { category?: string; search?: string }) => Promise<void>

  // Actions - downloads
  loadDownloads: () => Promise<void>

  // Actions - settings
  loadSettings: () => Promise<void>
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>

  // Actions - UI
  setLoading: (loading: boolean, message?: string) => void
  setSidebarCollapsed: (v: boolean) => void
  setActivePage: (page: string) => void
  setLauncherActive: (v: boolean) => void
  openCategory: (category: string) => void

  // Conflict detection
  detectConflicts: () => void

  // Real-time activity log (Dashboard console) + Vortex sync stats
  activityLog: LogLine[]
  pushLog: (message: string, level?: LogLine['level']) => void
  clearLog: () => void
  vortexStats: VortexStats | null
  loadVortexStats: () => Promise<void>
}

const defaultSettings: AppSettings = {
  language: 'it',
  theme: 'dark',
  autoSort: true,
  checkConflicts: true,
  autoBackup: true,
  downloadThreads: 4,
  textureQualityProfile: '4K',
  enableAutoTranslate: true,
}

// Guard di staleness per le load asincrone legate al profilo attivo: ogni load
// cattura il token corrente e scarta la propria risposta se nel frattempo è
// partita una load più recente (es. cambio rapido di profilo). Evita che la
// risposta IPC del profilo VECCHIO sovrascriva i dati di quello nuovo.
let modsLoadToken = 0
let downloadsLoadToken = 0

/** Esegue `worker` su ogni item con al massimo `limit` promesse in volo (pool). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

export const useAppStore = create<AppStore>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  mods: [],
  downloads: [],
  catalog: [],
  settings: defaultSettings,
  conflicts: [],
  modUpdates: {},
  activityLog: [],
  vortexStats: null,
  isLoading: false,
  loadingMessage: '',
  sidebarCollapsed: false,
  activePage: 'dashboard',
  launcherActive: true,
  modListFilter: '',

  loadProfiles: async () => {
    const profiles = await window.api.profiles.list()
    const savedId = (await window.api.settings.get('activeProfileId')) as number | undefined
    set({
      profiles,
      activeProfileId: savedId ?? profiles[0]?.id ?? null,
    })
  },

  createProfile: async (name, description) => {
    const profile = await window.api.profiles.create({ name, description })
    set((s) => ({ profiles: [...s.profiles, profile] }))
  },

  setActiveProfile: (id) => {
    set({ activeProfileId: id })
    window.api.settings.set('activeProfileId', id)
    get().loadMods(id)
    get().loadDownloads()
  },

  updateProfile: async (id, data) => {
    await window.api.profiles.update(id, data as Record<string, unknown>)
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...data } : p)),
    }))
  },

  deleteProfile: async (id) => {
    await window.api.profiles.delete(id)
    set((s) => ({
      profiles: s.profiles.filter((p) => p.id !== id),
      activeProfileId:
        s.activeProfileId === id ? (s.profiles.find((p) => p.id !== id)?.id ?? null) : s.activeProfileId,
    }))
  },

  loadMods: async (profileId) => {
    const id = profileId ?? get().activeProfileId
    if (!id) return
    const token = ++modsLoadToken
    const mods = await window.api.mods.list(id)
    if (token !== modsLoadToken) return // risposta stale: nel frattempo è partita una load più recente
    set({ mods })
    if (get().settings.checkConflicts) get().detectConflicts()
  },

  toggleMod: async (modId, enabled) => {
    await window.api.mods.update(modId, { is_enabled: enabled ? 1 : 0 })
    set((s) => ({ mods: s.mods.map((m) => (m.id === modId ? { ...m, is_enabled: enabled ? 1 : 0 } : m)) }))
    get().detectConflicts()
  },

  deleteMod: async (modId) => {
    await window.api.mods.delete(modId)
    set((s) => ({ mods: s.mods.filter((m) => m.id !== modId) }))
    get().detectConflicts()
  },

  reorderMods: async (items) => {
    const profileId = get().activeProfileId
    if (!profileId) return
    const orderedIds = items.map((i) => i.id)
    await window.api.mods.reorder(profileId, orderedIds)
    set((s) => {
      const modMap = new Map(s.mods.map((m) => [m.id, m]))
      const reordered = items.map(({ id, priority }) => ({ ...modMap.get(id)!, priority }))
      return { mods: reordered }
    })
    get().detectConflicts()
  },

  updateMod: async (modId, data) => {
    await window.api.mods.update(modId, data)
    set((s) => ({ mods: s.mods.map((m) => (m.id === modId ? { ...m, ...data } : m)) }))
  },

  markDriftFromChangeset: (rows) => {
    const byNexus = new Map(
      get()
        .mods.filter((m) => m.nexus_id != null)
        .map((m) => [m.nexus_id, m]),
    )
    const next: Record<number, { latestVersion: string; hasUpdate: boolean }> = {}
    let flagged = 0
    for (const r of rows) {
      if (r.change_type !== 'changed' || !r.to_version) continue // 'added' mods aren't installed locally
      const mod = byNexus.get(r.nexus_id)
      if (!mod) continue
      next[mod.id] = { latestVersion: r.to_version, hasUpdate: true }
      flagged++
    }
    set((s) => ({ modUpdates: { ...s.modUpdates, ...next } }))
    return flagged
  },

  checkAllUpdates: async () => {
    const { mods, activeProfileId } = get()

    // Primary path: the delta engine compares the PERSISTENT installed snapshot
    // against the latest ingested (signed) manifest and returns real version drift.
    // This replaces the per-mod mock loop with the actual delta source of truth.
    if (activeProfileId) {
      try {
        const res = await window.api.delta.checkUpdates(activeProfileId)
        if (res.ok) {
          const updates = get().markDriftFromChangeset(res.updates)
          return { checked: res.snapshotRows, updates }
        }
        // res.ok === false (e.g. no manifest ingested yet) → fall through to legacy.
      } catch {
        /* engine unavailable → legacy fallback */
      }
    }

    // Fallback: per-mod Nexus query (used when no signed release has been ingested).
    // Pool a concorrenza limitata (4 in volo, rispettoso del rate limit Nexus) invece
    // del vecchio loop seriale, e UN SOLO set() finale invece di uno per mod: con
    // migliaia di mod si passa da N re-render globali + O(n²) copie a un update solo.
    const withNexus = mods.filter((m) => m.nexus_id)
    const found: Record<number, { latestVersion: string; hasUpdate: boolean }> = {}
    let updates = 0
    await mapWithConcurrency(withNexus, 4, async (mod) => {
      try {
        const res = await window.api.nexus.getMod(mod.nexus_id!)
        if (!res.success || !res.data) return
        const latestVersion = (res.data as { version?: string }).version ?? null
        if (!latestVersion) return
        const hasUpdate = !!mod.version && latestVersion !== mod.version
        if (hasUpdate) updates++
        found[mod.id] = { latestVersion, hasUpdate }
      } catch {
        /* skip */
      }
    })
    set((s) => ({ modUpdates: { ...s.modUpdates, ...found } }))
    return { checked: withNexus.length, updates }
  },

  resolveConflict: async (modId, action) => {
    if (action === 'disable') {
      await get().toggleMod(modId, false)
    } else if (action === 'priority-top') {
      const { mods } = get()
      const others = mods.filter((m) => m.id !== modId)
      const target = mods.find((m) => m.id === modId)
      if (!target) return
      const reordered = [target, ...others].map((m, i) => ({ id: m.id, priority: i }))
      await get().reorderMods(reordered)
    }
    get().detectConflicts()
  },

  exportLoadOrder: () => {
    const { mods } = get()
    const sorted = [...mods].sort((a, b) => a.priority - b.priority)
    const modlistTxt = sorted.map((m) => `${m.is_enabled ? '+' : '-'}${m.name}`).join('\n')
    const pluginsTxt = sorted
      .filter((m) => m.is_enabled)
      .map((m) => `${m.name}.esp`)
      .join('\n')
    return { pluginsTxt, modlistTxt }
  },

  importFromMO2: async (modlistContent) => {
    const profileId = get().activeProfileId
    if (!profileId) return { imported: 0 }
    const entries = parseMO2Modlist(modlistContent)
    const existingNames = new Set(get().mods.map((m) => m.name.toLowerCase()))
    // Trasformazione pura (dedup + shaping) separata dal side-effect: un unico
    // batch IPC/transazione SQLite invece di N round-trip await-in-loop.
    const rows: Partial<Mod>[] = []
    for (const { name, enabled } of entries) {
      if (existingNames.has(name.toLowerCase())) continue
      existingNames.add(name.toLowerCase())
      rows.push({
        profile_id: profileId,
        name,
        category: 'other',
        file_size: 0,
        is_enabled: enabled ? 1 : 0,
        is_installed: 1,
        priority: rows.length,
        load_order: rows.length,
        tags: '[]',
        conflicts: '[]',
        requires: '[]',
        translation_it: 0,
      })
    }
    if (rows.length) await window.api.mods.addMany(rows)
    await get().loadMods(profileId)
    return { imported: rows.length }
  },

  checkForUpdates: async (modId) => {
    const mod = get().mods.find((m) => m.id === modId)
    if (!mod?.nexus_id) return { hasUpdate: false }
    const res = await window.api.nexus.getMod(mod.nexus_id)
    if (!res.success || !res.data) return { hasUpdate: false }
    const data = res.data as { version?: string }
    const latestVersion = data.version ?? null
    if (!latestVersion) return { hasUpdate: false }
    const hasUpdate = !!mod.version && latestVersion !== mod.version
    set((s) => ({ modUpdates: { ...s.modUpdates, [modId]: { latestVersion, hasUpdate } } }))
    return { hasUpdate, latestVersion }
  },

  loadCatalog: async (filter) => {
    const catalog = await window.api.catalog.list(filter)
    set({ catalog })
  },

  loadDownloads: async () => {
    const profileId = get().activeProfileId
    if (!profileId) return
    const token = ++downloadsLoadToken
    const downloads = await window.api.downloads.list(profileId)
    if (token !== downloadsLoadToken) return // risposta stale
    set({ downloads })
  },

  loadSettings: async () => {
    const all = (await window.api.settings.getAll()) as Partial<AppSettings>
    set({ settings: { ...defaultSettings, ...all } })
  },

  updateSettings: async (partial) => {
    const previous = get().settings
    set({ settings: { ...previous, ...partial } })
    try {
      // Persistenza in parallelo: le chiavi sono indipendenti tra loro.
      await Promise.all(Object.entries(partial).map(([k, v]) => window.api.settings.set(k, v)))
    } catch (e) {
      // Rollback dell'update ottimistico: UI e persistenza non devono divergere.
      set({ settings: previous })
      throw e
    }
  },

  pushLog: (message, level = 'info') =>
    set((s) => {
      const id = (s.activityLog[s.activityLog.length - 1]?.id ?? 0) + 1
      const line: LogLine = { id, time: new Date().toLocaleTimeString('it-IT'), level, message }
      const next = [...s.activityLog, line]
      return { activityLog: next.length > 200 ? next.slice(-200) : next } // cap the buffer
    }),
  clearLog: () => set({ activityLog: [] }),

  loadVortexStats: async () => {
    try {
      const s = await window.api.vortex.scan()
      set({
        vortexStats: {
          uniqueMods: s.mods.length,
          totalBytes: s.totalBytes,
          collections: s.collections.length,
          duplicatesRemoved: s.duplicatesRemoved,
        },
      })
    } catch {
      /* Vortex not present / scan failed — leave stats null */
    }
  },

  setLoading: (isLoading, loadingMessage = '') => set({ isLoading, loadingMessage }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setActivePage: (activePage) => set({ activePage, modListFilter: '' }),
  setLauncherActive: (launcherActive) => set({ launcherActive }),
  openCategory: (category) => set({ activePage: 'modlist', modListFilter: category }),

  detectConflicts: () => {
    const { mods } = get()
    const conflicts: ConflictInfo[] = []
    const enabledMods = mods.filter((m) => m.is_enabled)
    const seen = new Set<string>()

    // Precompute once: lowercase names and parsed JSON fields. Previously these
    // were recomputed inside nested loops (O(n²) toLowerCase + repeated JSON.parse
    // on every mutation); hoisting them keeps the constants tiny.
    const parseArr = (s: string): string[] => {
      try {
        return JSON.parse(s || '[]') as string[]
      } catch {
        return []
      }
    }
    const enriched = enabledMods.map((m) => ({
      mod: m,
      lname: m.name.toLowerCase(),
      requires: parseArr(m.requires),
      conflicts: parseArr(m.conflicts),
    }))
    const lnames = enriched.map((e) => e.lname)
    const nameIncludes = (needleLower: string) => lnames.some((n) => n.includes(needleLower))
    const findByName = (needleLower: string) => enriched.find((e) => e.lname.includes(needleLower))?.mod

    const addConflict = (c: ConflictInfo) => {
      const key = `${c.modId}-${c.conflictType}-${c.message}`
      if (!seen.has(key)) {
        seen.add(key)
        conflicts.push(c)
      }
    }

    // Gruppi a mutua esclusione (un solo body replacer, un solo preset ENB, …). La logica vive in
    // ./lib/exclusionGroups: famiglie + esclusione dei derivati, perché il match per substring sul
    // nome segnalava ogni armatura convertita per CBBE come "incompatibile" col body CBBE stesso.
    for (const hit of detectExclusionConflicts(enabledMods.map((m) => ({ id: m.id, name: m.name })))) {
      for (const mod of hit.members) {
        addConflict({
          modId: mod.id,
          modName: mod.name,
          conflictType: 'incompatible',
          severity: hit.severity,
          message: `Conflitto gruppo "${hit.label}": attive ${hit.members.length} mod di famiglie incompatibili (${hit.families.join(' vs ')})`,
        })
      }
    }

    for (const { mod, requires, conflicts: conflictsWith } of enriched) {
      // Missing masters / requirements
      for (const req of requires) {
        if (!nameIncludes(req.toLowerCase())) {
          addConflict({
            modId: mod.id,
            modName: mod.name,
            conflictType: 'missing-master',
            severity: 'error',
            message: `Dipendenza mancante: "${req}"`,
          })
        }
      }

      // Explicit conflicts declared in mod data
      for (const name of conflictsWith) {
        const found = findByName(name.toLowerCase())
        if (found) {
          addConflict({
            modId: mod.id,
            modName: mod.name,
            conflictType: 'incompatible',
            severity: 'warning',
            message: `Incompatibile con: ${found.name}`,
          })
        }
      }

      // Patch mods without their target being active
      if (mod.category === 'patch' && requires.length === 0) {
        addConflict({
          modId: mod.id,
          modName: mod.name,
          conflictType: 'missing-master',
          severity: 'warning',
          message: `Patch senza dipendenze dichiarate — verifica i requisiti`,
        })
      }
    }

    // Load order: framework mods should have lower priority (loaded first)
    const frameworkMods = enabledMods.filter((m) => m.category === 'framework')
    const nonFramework = enabledMods.filter((m) => m.category !== 'framework')
    for (const fw of frameworkMods) {
      const wrongOrder = nonFramework.find((m) => m.priority < fw.priority)
      if (wrongOrder) {
        addConflict({
          modId: fw.id,
          modName: fw.name,
          conflictType: 'overwrite',
          severity: 'warning',
          message: `Framework "${fw.name}" ha priorità ${fw.priority} — dovrebbe caricare prima di mod non-framework`,
        })
        break
      }
    }

    set({ conflicts })
  },
}))
