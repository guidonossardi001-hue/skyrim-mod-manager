// ============================================================================
// Mock backend completo per il preview in BROWSER (non Electron).
// Implementa un vero backend in-memory con persistenza su localStorage:
// catalogo reale, CRUD mod/profili/download persistenti, Nexus simulato,
// download che avanzano nel tempo, backup funzionanti, file-picker via prompt.
// ============================================================================

import type { Mod, Profile, Download, CatalogMod, DeltaChangeRow } from '@/types'
import { MODLIST_CATALOG } from '@/data/modlistCatalog'
import { runLaunchWorkflow, type LaunchEnv, SKYRIM_SE_APPID } from '@/lib/launchWorkflow'
// runActiveLaunch is browser-safe: it only imports runLaunchWorkflow at runtime
// (all bootstrapper/steam/updater imports are type-only and erased).
import { runActiveLaunch, type LaunchProgress } from '../electron/launch/activeLaunch'
import type { BootstrapTarget } from '../electron/launch/bootstrapper'
import { analyzeModlist, type CompatMod, type CompatAnalysis } from '@/lib/compatibility'
import { derivePluginsFromMods } from '@/lib/plugins'
import { resolveInstallPlan } from '@/lib/dependencies'

const STORAGE_KEY = 'skyrim-mm-state-v2'

interface PersistState {
  profiles: Profile[]
  mods: Mod[]
  downloads: Download[]
  settings: Record<string, unknown>
  backups: BackupEntry[]
  nextModId: number
  nextDownloadId: number
  nextProfileId: number
  nextBackupId: number
}

interface BackupEntry {
  name: string
  path: string
  size: number
  date: string
  snapshot: Mod[]
}

// ─── Stato iniziale ──────────────────────────────────────────────────────────
const INITIAL_MODS: Mod[] = [
  {
    id: 1,
    profile_id: 1,
    nexus_id: 17230,
    name: 'SKSE64 – Skyrim Script Extender',
    version: '2.2.6',
    author: 'ianpatt',
    category: 'framework',
    description: 'Engine scripting extender',
    file_size: 5 * 1024 * 1024,
    install_path: null,
    is_enabled: 1,
    is_installed: 1,
    load_order: 1,
    priority: 1,
    tags: '["essenziale","engine"]',
    conflicts: '[]',
    requires: '[]',
    translation_it: 0,
    nexus_url: 'https://www.nexusmods.com/skyrimspecialedition/mods/17230',
    thumbnail_url: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 2,
    profile_id: 1,
    nexus_id: 1137,
    name: 'SkyUI',
    version: '5.2SE',
    author: 'schlangster',
    category: 'ui',
    description: 'Interfaccia utente moderna',
    file_size: 8 * 1024 * 1024,
    install_path: null,
    is_enabled: 1,
    is_installed: 1,
    load_order: 2,
    priority: 2,
    tags: '["essenziale","ui"]',
    conflicts: '[]',
    requires: '["SKSE64"]',
    translation_it: 1,
    nexus_url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1137',
    thumbnail_url: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 3,
    profile_id: 1,
    nexus_id: 198,
    name: 'CBBE – Caliente Beautiful Bodies',
    version: '2.0',
    author: 'Caliente',
    category: 'character',
    description: 'Corpo femminile migliorato',
    file_size: 200 * 1024 * 1024,
    install_path: null,
    is_enabled: 1,
    is_installed: 1,
    load_order: 3,
    priority: 3,
    tags: '["corpo","femminile"]',
    conflicts: '[]',
    requires: '[]',
    translation_it: 0,
    nexus_url: null,
    thumbnail_url: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 4,
    profile_id: 1,
    nexus_id: 89368,
    name: 'MCO – Modern Combat Overhaul',
    version: '1.4.5',
    author: 'Distar',
    category: 'combat',
    description: 'Sistema combat action',
    file_size: 200 * 1024 * 1024,
    install_path: null,
    is_enabled: 1,
    is_installed: 1,
    load_order: 4,
    priority: 4,
    tags: '["combat","mco"]',
    conflicts: '[]',
    requires: '["SKSE64"]',
    translation_it: 0,
    nexus_url: null,
    thumbnail_url: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 5,
    profile_id: 1,
    nexus_id: 1845,
    name: 'Apocalypse – Magic of Skyrim',
    version: '9.45',
    author: 'EnaiSiaion',
    category: 'gameplay',
    description: '155 nuove spell',
    file_size: 50 * 1024 * 1024,
    install_path: null,
    is_enabled: 1,
    is_installed: 1,
    load_order: 5,
    priority: 5,
    tags: '["magia","spell"]',
    conflicts: '[]',
    requires: '[]',
    translation_it: 1,
    nexus_url: null,
    thumbnail_url: null,
    created_at: '',
    updated_at: '',
  },
]

const INITIAL_PROFILES: Profile[] = [
  {
    id: 1,
    name: 'Anime Fantasy Default',
    description: 'Profilo principale - Mix Anime 50% / Fantasy 50%',
    game_path: null,
    mo2_path: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  },
]

const INITIAL_DOWNLOADS: Download[] = [
  {
    id: 1,
    mod_id: null,
    profile_id: 1,
    nexus_id: 30174,
    file_id: null,
    name: 'CBBE 3BA (3 Body Alternative)',
    url: null,
    file_path: null,
    total_size: 310 * 1024 * 1024,
    downloaded_size: 120 * 1024 * 1024,
    status: 'downloading',
    error: null,
    created_at: '',
  },
  {
    id: 2,
    mod_id: null,
    profile_id: 1,
    nexus_id: 12092,
    file_id: null,
    name: 'KS Hairdos SSE',
    url: null,
    file_path: null,
    total_size: 1500 * 1024 * 1024,
    downloaded_size: 300 * 1024 * 1024,
    status: 'downloading',
    error: null,
    created_at: '',
  },
  {
    id: 3,
    mod_id: 1,
    profile_id: 1,
    nexus_id: 17230,
    file_id: null,
    name: 'SKSE64 AE 2.2.6',
    url: null,
    file_path: 'C:\\mods\\skse.zip',
    total_size: 5 * 1024 * 1024,
    downloaded_size: 5 * 1024 * 1024,
    status: 'completed',
    error: null,
    created_at: '',
  },
  {
    id: 4,
    mod_id: 2,
    profile_id: 1,
    nexus_id: 1137,
    file_id: null,
    name: 'SkyUI v5.2SE',
    url: null,
    file_path: 'C:\\mods\\skyui.zip',
    total_size: 8 * 1024 * 1024,
    downloaded_size: 8 * 1024 * 1024,
    status: 'completed',
    error: null,
    created_at: '',
  },
]

const DEFAULT_SETTINGS: Record<string, unknown> = {
  language: 'it',
  theme: 'dark',
  autoSort: true,
  checkConflicts: true,
  autoBackup: true,
  downloadThreads: 4,
  downloadRetries: 3,
  errorThreshold: 50,
  textureQualityProfile: '4K',
  enableAutoTranslate: true,
}

// ─── Caricamento / persistenza ───────────────────────────────────────────────
function loadState(): PersistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as PersistState
  } catch {
    /* ignore */
  }
  return {
    profiles: structuredClone(INITIAL_PROFILES),
    mods: structuredClone(INITIAL_MODS),
    downloads: structuredClone(INITIAL_DOWNLOADS),
    settings: { ...DEFAULT_SETTINGS },
    backups: [],
    nextModId: 6,
    nextDownloadId: 5,
    nextProfileId: 2,
    nextBackupId: 1,
  }
}

const state = loadState()

// Catalogo: derivato da MODLIST_CATALOG con id assegnati (sempre fresco)
const catalog: CatalogMod[] = MODLIST_CATALOG.map((m, i) => ({ ...m, id: i + 1 }))

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const noop = async () => {}
const ok = async () => ({ success: true })
const nowIso = () => new Date().toISOString()

// ─── Avanzamento download simulato (basato sul tempo reale) ──────────────────
const tickTimes: Record<number, number> = {}
const DOWNLOAD_DURATION_MS = 22_000 // ~22s per completare un download
const MAX_CONCURRENT = 3

const installTimes: Record<number, number> = {}
const INSTALL_DURATION_MS = 1500 // simulated extraction time

function promoteToDownloading(id: number) {
  const d = state.downloads.find((x) => x.id === id)
  if (d && (d.status === 'pending' || d.status === 'paused')) {
    d.status = 'downloading'
    d.error = null
    tickTimes[id] = Date.now()
    persist()
  }
}

function tickDownloads() {
  const now = Date.now()
  const profileDownloads = state.downloads
  let changed = false

  for (const d of profileDownloads) {
    if (d.status === 'downloading') {
      const last = tickTimes[d.id] ?? now
      tickTimes[d.id] = now
      const inc = d.total_size * ((now - last) / DOWNLOAD_DURATION_MS)
      if (inc <= 0) continue
      d.downloaded_size = Math.min(d.total_size, d.downloaded_size + inc)
      changed = true
      if (d.downloaded_size >= d.total_size) {
        // Download done → hand off to the simulated install (extraction) phase,
        // mirroring the real pipeline (downloadManager → installManager).
        d.downloaded_size = d.total_size
        d.file_path = `C:\\Mods\\Downloads\\${d.name.replace(/[^\w]+/g, '_')}.7z`
        d.status = 'installing'
        installTimes[d.id] = now
      }
    } else if (d.status === 'installing') {
      if (now - (installTimes[d.id] ?? now) >= INSTALL_DURATION_MS) {
        d.status = 'completed'
        changed = true
        // Flip the linked mod to installed, just like installManager does.
        if (d.mod_id != null) {
          const mod = state.mods.find((m) => m.id === d.mod_id)
          if (mod) {
            mod.is_installed = 1
            mod.install_path = `C:\\Mods\\${d.name}`
          }
        }
      }
    }
  }

  // Promuovi i pending a downloading rispettando il limite di concorrenza
  let active = profileDownloads.filter((d) => d.status === 'downloading' || d.status === 'installing').length
  for (const d of profileDownloads) {
    if (active >= MAX_CONCURRENT) break
    if (d.status === 'pending') {
      d.status = 'downloading'
      tickTimes[d.id] = now
      active++
      changed = true
    }
  }

  if (changed) persist()
}

// ─── Helpers Nexus simulato ──────────────────────────────────────────────────
function bumpVersion(v: string | null): string {
  if (!v) return '1.0.1'
  return `${v}-hotfix2`
}

// Build a simulated launch environment from the in-memory state so the browser
// preview can demonstrate the gated pre-flight (configuring settings/mods changes it).
function buildMockLaunchEnv(): LaunchEnv {
  const s = state.settings as Record<string, string | undefined>
  const mods = state.mods
  const hasSkse = mods.some((m) => /skse/i.test(m.name) && m.is_installed)
  const hasAddr = mods.some((m) => /address library/i.test(m.name) && m.is_installed)
  return {
    steam: {
      installed: true,
      running: true,
      path: 'C:/Program Files (x86)/Steam',
      libraries: ['C:/Program Files (x86)/Steam'],
    },
    skyrim: { appId: 489830, installed: !!s.gamePath, path: s.gamePath ?? null, version: null },
    skse: {
      present: hasSkse,
      version: hasSkse ? '2.2.6' : null,
      gameVersionSupported: hasSkse ? true : null,
    },
    addressLibrary: { present: hasAddr, correctForVersion: hasAddr ? true : null },
    mo2: { path: s.mo2Path ?? null, valid: !!s.mo2Path },
    mods: {
      total: mods.length,
      enabled: mods.filter((m) => m.is_enabled).length,
      installed: mods.filter((m) => m.is_installed).length,
    },
    plugins: [],
    modlist: { complete: true, missing: [] },
    manifest: { used: false, verified: false, reason: null },
    backups: { count: state.backups.length, lastValid: state.backups.length > 0 },
    launchTarget: s.mo2Path ? 'mo2' : hasSkse ? 'skse' : null,
    // Anteprima: guard non protetto (mostra il warning e il toggle in Impostazioni ha effetto).
    updateGuard: { found: true, protected: mockGuardProtected, drift: null },
    deployIntegrity: undefined,
    saveDoctor: undefined,
  }
}

// Stato del mock della protezione aggiornamenti (toggle verificabile in anteprima).
let mockGuardProtected = false

// ── One-Click Play simulation (browser preview) ──────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const launchListeners = new Set<(p: LaunchProgress) => void>()
const emitLaunchProgress = (ev: LaunchProgress) => launchListeners.forEach((cb) => cb(ev))

let mockSmart = {
  autoLaunch: false,
  lastBootstrapperId: null as string | null,
  lastProfileId: null as number | null,
  lastLaunchAt: null as string | null,
  launchCount: 0,
}

// Mirror the real bootstrapper priority (MO2 → SKSE → DragonLoader) without
// pulling the fs-bound electron module into the browser bundle.
function mockResolveTarget(env: LaunchEnv): BootstrapTarget | null {
  if (env.mo2.path)
    return {
      bootstrapperId: 'mo2',
      bootstrapperName: 'Mod Organizer 2',
      mode: 'exe',
      exe: env.mo2.path,
      cwd: env.mo2.path,
      args: [],
      description: 'Avvio tramite Mod Organizer 2',
    }
  if (env.skse.present && env.skyrim.path)
    return {
      bootstrapperId: 'skse',
      bootstrapperName: 'SKSE64',
      mode: 'exe',
      exe: `${env.skyrim.path}/skse64_loader.exe`,
      cwd: env.skyrim.path,
      args: [],
      description: 'Avvio tramite Skyrim Script Extender',
    }
  if (env.skyrim.path)
    return {
      bootstrapperId: 'dragonloader',
      bootstrapperName: 'DragonLoader',
      mode: 'protocol',
      uri: `steam://run/${SKYRIM_SE_APPID}`,
      description: 'Avvio tramite meccanismo Steam legittimo (steam://run)',
    }
  return null
}

// ─── Simulazione motore delta (preview browser) ──────────────────────────────
// Riproduce il contratto reale di DeltaService (ingest→check→list→apply→finalize)
// per dimostrare il flusso visivo. In Electron gira il motore reale firmato Ed25519.
interface DeltaRowSim extends DeltaChangeRow {
  profile_id: number
  to_release_id: number
  category: string
}
const deltaSim: { releaseId: number; releaseTag: string; rows: DeltaRowSim[] } = {
  releaseId: 0,
  releaseTag: '',
  rows: [],
}

function buildDeltaChangeset(profileId: number): DeltaRowSim[] {
  // Changeset plausibile, ancorato alle mod realmente installate: bump di versione
  // (changed), una nuova dipendenza (added) e un riordino (reordered).
  const installed = state.mods.filter((m) => m.is_installed)
  let rid = 1
  const rows: DeltaRowSim[] = []
  const mk = (
    over: Partial<DeltaRowSim> & {
      nexus_id: number
      name: string
      change_type: DeltaChangeRow['change_type']
    },
  ): DeltaRowSim => ({
    id: rid++,
    profile_id: profileId,
    to_release_id: 1,
    from_version: null,
    to_version: null,
    to_file_name: null,
    to_load_order: null,
    category: 'other',
    status: 'pending',
    ...over,
  })

  for (const m of installed.filter((m) => /skyui|apocalypse|cbbe|mco/i.test(m.name)).slice(0, 2)) {
    rows.push(
      mk({
        nexus_id: m.nexus_id ?? 0,
        name: m.name,
        change_type: 'changed',
        from_version: m.version,
        to_version: bumpVersion(m.version),
        to_load_order: m.load_order,
        category: m.category,
      }),
    )
  }
  if (!state.mods.some((m) => m.nexus_id === 32444)) {
    rows.push(
      mk({
        nexus_id: 32444,
        name: 'Address Library for SKSE Plugins',
        change_type: 'added',
        to_version: '5.0',
        to_file_name: 'Address Library.7z',
        to_load_order: 999,
        category: 'framework',
      }),
    )
  }
  const reord = installed.find((m) => /skse/i.test(m.name))
  if (reord) {
    rows.push(
      mk({
        nexus_id: reord.nexus_id ?? 0,
        name: reord.name,
        change_type: 'reordered',
        from_version: reord.version,
        to_version: reord.version,
        to_load_order: (reord.load_order || 1) + 1,
        category: reord.category,
      }),
    )
  }
  return rows
}

// ─── API mock ────────────────────────────────────────────────────────────────
export const mockApi = {
  window: {
    minimize: noop,
    maximize: noop,
    close: noop,
    isMaximized: async () => false,
  },

  settings: {
    get: async (k: string) => state.settings[k] ?? null,
    set: async (k: string, v: unknown) => {
      state.settings[k] = v
      persist()
    },
    getAll: async () => ({ ...DEFAULT_SETTINGS, ...state.settings }),
  },

  profiles: {
    list: async () => clone(state.profiles),
    create: async (d: { name: string; description?: string }) => {
      const p: Profile = {
        id: state.nextProfileId++,
        name: d.name,
        description: d.description ?? '',
        game_path: null,
        mo2_path: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      }
      state.profiles.push(p)
      persist()
      return clone(p)
    },
    update: async (id: number, d: Partial<Profile>) => {
      const p = state.profiles.find((x) => x.id === id)
      if (p) {
        Object.assign(p, d, { updated_at: nowIso() })
        persist()
      }
      return clone(p ?? state.profiles[0])
    },
    delete: async (id: number) => {
      state.profiles = state.profiles.filter((p) => p.id !== id)
      state.mods = state.mods.filter((m) => m.profile_id !== id)
      persist()
    },
  },

  mods: {
    list: async (profileId: number) => clone(state.mods.filter((m) => m.profile_id === profileId)),
    add: async (d: Partial<Mod>) => {
      const m: Mod = {
        id: state.nextModId++,
        profile_id: d.profile_id ?? 1,
        nexus_id: d.nexus_id ?? null,
        name: d.name ?? 'Mod senza nome',
        version: d.version ?? null,
        author: d.author ?? null,
        category: d.category ?? 'other',
        description: d.description ?? null,
        file_size: d.file_size ?? 0,
        install_path: d.install_path ?? null,
        is_enabled: d.is_enabled ?? 1,
        is_installed: d.is_installed ?? 0,
        load_order: d.load_order ?? state.mods.length + 1,
        priority: d.priority ?? state.mods.length + 1,
        tags: d.tags ?? '[]',
        conflicts: d.conflicts ?? '[]',
        requires: d.requires ?? '[]',
        translation_it: d.translation_it ?? 0,
        nexus_url: d.nexus_url ?? null,
        thumbnail_url: d.thumbnail_url ?? null,
        created_at: nowIso(),
        updated_at: nowIso(),
      }
      state.mods.push(m)
      persist()
      return clone(m)
    },
    addMany: async (rows: Partial<Mod>[]) => {
      for (const d of rows) {
        state.mods.push({
          id: state.nextModId++,
          profile_id: d.profile_id ?? 1,
          nexus_id: d.nexus_id ?? null,
          name: d.name ?? 'Mod senza nome',
          version: d.version ?? null,
          author: d.author ?? null,
          category: d.category ?? 'other',
          description: d.description ?? null,
          file_size: d.file_size ?? 0,
          install_path: d.install_path ?? null,
          is_enabled: d.is_enabled ?? 1,
          is_installed: d.is_installed ?? 0,
          load_order: d.load_order ?? state.mods.length + 1,
          priority: d.priority ?? state.mods.length + 1,
          tags: d.tags ?? '[]',
          conflicts: d.conflicts ?? '[]',
          requires: d.requires ?? '[]',
          translation_it: d.translation_it ?? 0,
          nexus_url: d.nexus_url ?? null,
          thumbnail_url: d.thumbnail_url ?? null,
          created_at: nowIso(),
          updated_at: nowIso(),
        })
      }
      persist()
      return { inserted: rows.length }
    },
    update: async (id: number, d: Partial<Mod>) => {
      const m = state.mods.find((x) => x.id === id)
      if (m) {
        Object.assign(m, d, { updated_at: nowIso() })
        persist()
      }
      return clone(m ?? state.mods[0])
    },
    delete: async (id: number) => {
      state.mods = state.mods.filter((m) => m.id !== id)
      persist()
    },
    reorder: async (_profileId: number, orderedIds: number[]) => {
      orderedIds.forEach((id, idx) => {
        const m = state.mods.find((x) => x.id === id)
        if (m) m.priority = idx + 1
      })
      persist()
    },
  },

  catalog: {
    list: async (filter?: { category?: string; search?: string }) => {
      let result = clone(catalog)
      if (filter?.category) result = result.filter((m) => m.category === filter.category)
      if (filter?.search) {
        const s = filter.search.toLowerCase()
        result = result.filter(
          (m) => m.name.toLowerCase().includes(s) || (m.description?.toLowerCase().includes(s) ?? false),
        )
      }
      return result
    },
    seed: async () => ({ inserted: catalog.length }),
    // Preview stub: no Vortex backup on disk in the browser mock.
    importVortex: async () => ({ success: false as const, error: 'Backup Vortex non disponibile in anteprima' }),
    importNexusCollection: async () => ({
      success: false as const,
      error: 'Import Collection Nexus disponibile solo nell’app desktop',
    }),
    dedupe: async () => ({ success: true as const, removed: 0, total: catalog.length }),
    // Preview stub: il wipe agisce sul DB reale (solo app desktop).
    wipe: async () => ({ ok: false as const, error: 'Svuotamento catalogo disponibile solo nell’app desktop' }),
    // Preview stub: il pruning richiede il backup raw su disco (solo app desktop).
    pruneCollection: async () => ({
      ok: false as const,
      error: 'Pruning collezioni disponibile solo nell’app desktop (serve il backup Vortex)',
    }),
    // Preview stub: dati seed sempre validi — il report riflette la forma reale.
    validateDownloads: async () => ({
      ok: true as const,
      backfilled: 0,
      queue: {
        total: catalog.length,
        valid: catalog.length,
        invalidCount: 0,
        warningCount: 0,
        invalid: [],
        warnings: [],
      },
      catalog: { checked: catalog.length, ok: catalog.length, missingUrlCount: 0, badModIdCount: 0, missingUrl: [] },
    }),
    // Preview stub: the real backend fetches a signed remote catalog and replaces
    // modlist_catalog wholesale. Here there is no signed endpoint, so mirror the
    // real "URL non configurato" no-throw failure the packaged app returns when
    // NOLVUS_MOD_CATALOG_URL is unset — the button + error toast stay verifiable.
    update: async () => ({
      success: false as const,
      errorKind: 'network' as const,
      error: 'URL catalogo non configurato (NOLVUS_MOD_CATALOG_URL)',
    }),
    // Mirrors the backend InstallPlanResult shape. Resolves `requires` by name
    // (the seed catalog's legacy format) so dependency chains produce a real
    // forced order for the preview demo; cycle/conflict branches share the shape.
    resolvePlan: async (targetIds: number[], installedIds: number[]) => {
      const installed = new Set<number>(installedIds)
      const byNexus = new Map(catalog.map((m) => [m.nexus_id, m]))
      const planned = new Map<number, { mod: CatalogMod; reason: 'target' | 'dependency' }>()
      const missing: string[] = []
      for (const id of targetIds) {
        const mod = byNexus.get(id)
        if (!mod) {
          missing.push(`target ${id} assente dal catalogo`)
          continue
        }
        for (const item of resolveInstallPlan(mod, catalog, installed)) {
          const prev = planned.get(item.mod.nexus_id)
          if (!prev || item.reason === 'target') planned.set(item.mod.nexus_id, item)
        }
      }
      if (missing.length) return { success: false, errorKind: 'missing' as const, errors: missing }
      const plan = [...planned.values()]
        .sort((a, b) => a.mod.priority_order - b.mod.priority_order)
        .map((it) => ({
          nexus_id: it.mod.nexus_id,
          name: it.mod.name,
          priority_order: it.mod.priority_order,
          reason: it.reason,
        }))
      // Demo data for the "Conflitti Auto-risolti" panel: with ≥2 mods planned we
      // fake a couple of file-override collisions the deploy engine would auto-resolve
      // (real values come from computeDeployPlan.resolvedConflicts at deploy time).
      const resolvedConflicts =
        plan.length >= 2
          ? [
              { file: 'textures/armor/steel/steelarmor.dds', winner: plan[1].name, loser: plan[0].name },
              { file: 'meshes/actors/character/character assets/skeleton.nif', winner: plan[0].name, loser: plan[1].name },
            ]
          : []
      return { success: true as const, plan, resolvedConflicts }
    },
  },

  // Preview stub: il deploy reale crea hardlink/junction su disco (solo app desktop). Il mock
  // simula un run riuscito con numeri plausibili così la card Deployment è verificabile in anteprima.
  deploy: {
    run: async (_profileId: number) => {
      const enabled = state.mods.filter((m) => m.is_enabled && m.is_installed).length
      if (!enabled) return { success: false as const, errorKind: 'no-mods' as const, error: 'nessuna mod abilitata da distribuire' }
      return {
        success: true as const,
        instanceDataDir: 'C:/preview/instances/Default/Data',
        modsLinked: enabled,
        filesHardlinked: enabled * 12,
        junctionsCreated: Math.max(1, Math.floor(enabled / 2)),
        pluginsWritten: enabled,
        pluginsPath: 'C:/preview/instances/Default/plugins.txt',
        systemPluginsPath: 'C:/preview/AppData/Local/Skyrim Special Edition/plugins.txt',
        ccFilesLinked: 0,
      }
    },
    purge: async (_profileId: number) => ({
      success: true as const,
      manifestFound: true,
      filesRemoved: 24,
      junctionsRemoved: 2,
      dirsPruned: 3,
      skipped: 0,
      systemPluginsRestored: true,
    }),
    onProgress: (_cb: unknown) => () => {},
    preview: async (_profileId: number) => ({
      ok: true as const,
      modsScanned: state.mods.filter((m) => m.is_enabled).length,
      conflicts: [],
      pluginBudget: { full: 12, light: 3, maxFull: 254 },
      loadOrderIssue: null,
      warnings: [],
    }),
    prefer: async () => ({ ok: false as const, error: 'Risoluzione conflitti disponibile solo nell’app desktop' }),
    // Anteprima: la verifica reale confronta manifest e disco (solo app desktop).
    verify: async () => ({
      checked: true,
      totalFiles: 126,
      intactFiles: 126,
      missing: [] as string[],
      replaced: [] as string[],
      junctionsMissing: [] as string[],
      missingCount: 0,
      replacedCount: 0,
      junctionsMissingCount: 0,
    }),
  },

  // Protezione aggiornamenti Steam (mock con stato: il toggle si riflette nello status).
  updateGuard: {
    status: async () => ({
      found: true,
      manifestPath: 'C:/Program Files (x86)/Steam/steamapps/appmanifest_489830.acf',
      protected: mockGuardProtected,
      autoUpdateBehavior: 0,
      buildId: '16543012',
    }),
    set: async (enabled: boolean) => {
      mockGuardProtected = enabled === true
      return { success: true, protected: mockGuardProtected }
    },
  },

  // Save Doctor (anteprima: diagnosi d'esempio coerente e innocua).
  saves: {
    doctor: async () => ({
      checked: false,
      saveName: null,
      playerName: null,
      playerLevel: null,
      playerLocation: null,
      missingPlugins: [] as string[],
      missingCount: 0,
      totalSavePlugins: 0,
    }),
  },

  masterlist: {
    refresh: async () => ({ ok: false as const, error: 'Masterlist LOOT disponibile solo nell’app desktop' }),
    status: async () => ({ ok: true as const, cached: false as const }),
  },

  crash: {
    listRecent: async () => ({ ok: false as const, error: 'Analisi crash log disponibile solo nell’app desktop' }),
    analyze: async () => ({ ok: false as const, error: 'Analisi crash log disponibile solo nell’app desktop' }),
  },

  enb: {
    scan: async () => ({ ok: true as const, presets: [] }),
    apply: async () => ({ ok: false as const, error: 'Gestione ENB disponibile solo nell’app desktop' }),
    remove: async () => ({ ok: true as const, removed: 0, restored: 0 }),
  },

  fomod: {
    fetchChoices: async () => ({ ok: false as const, error: 'FOMOD disponibile solo nell’app desktop' }),
    scan: async () => ({ ok: true as const, total: 0, applied: 0, withChoices: 0, choicesCached: false }),
    applyAll: async () => ({ ok: false as const, error: 'FOMOD disponibile solo nell’app desktop' }),
  },

  downloads: {
    list: async (profileId: number) => {
      tickDownloads()
      return clone(state.downloads.filter((d) => d.profile_id === profileId))
    },
    add: async (d: Partial<Download>) => {
      const dl: Download = {
        id: state.nextDownloadId++,
        mod_id: d.mod_id ?? null,
        profile_id: d.profile_id ?? 1,
        nexus_id: d.nexus_id ?? null,
        file_id: d.file_id ?? null,
        name: d.name ?? 'Download',
        url: d.url ?? null,
        file_path: d.file_path ?? null,
        total_size: d.total_size ?? 0,
        downloaded_size: d.downloaded_size ?? 0,
        status: d.status ?? 'pending',
        error: d.error ?? null,
        created_at: nowIso(),
      }
      state.downloads.push(dl)
      persist()
      return dl.id
    },
    updateStatus: async (id: number, status: string, extra?: Record<string, unknown>) => {
      const dl = state.downloads.find((x) => x.id === id)
      if (dl) {
        dl.status = status as Download['status']
        if (extra) Object.assign(dl, extra)
        persist()
      }
    },
    retryFailed: async () => {
      let retried = 0
      for (const dl of state.downloads) {
        if (dl.status === 'failed') {
          dl.status = 'pending'
          dl.error = null
          retried++
        }
      }
      persist()
      return { retried }
    },
  },

  nexus: {
    getMod: async (nexusId: number) => {
      const mod = state.mods.find((m) => m.nexus_id === nexusId)
      const current = mod?.version ?? '1.0.0'
      const hasUpdate = nexusId % 3 === 0 // ~1/3 delle mod hanno un aggiornamento
      return {
        success: true,
        data: {
          mod_id: nexusId,
          name: mod?.name ?? `Mod ${nexusId}`,
          version: hasUpdate ? bumpVersion(current) : current,
          author: mod?.author ?? 'Unknown',
          summary: mod?.description ?? '',
        },
      }
    },
    validateKey: async (apiKey?: string) => {
      if (apiKey && apiKey.trim().length >= 8) {
        return { success: true, data: { name: 'NexusUser (demo)', is_premium: true, is_supporter: true } }
      }
      return { success: false }
    },
  },

  // nxm:// consent gate — no real protocol handling in the browser mock; nothing is ever pending.
  nxm: {
    listPending: async () => [],
    approve: async () => ({ ok: true }),
    reject: async () => ({ ok: true }),
  },

  fs: {
    pickDirectory: async (title?: string) => {
      const def = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Skyrim Special Edition'
      try {
        return window.prompt(title ?? 'Seleziona cartella', def)
      } catch {
        return def
      }
    },
    pickFile: async (title?: string, _filters?: unknown[]) => {
      const t = (title ?? '').toLowerCase()
      let def = 'C:\\Tools\\app.exe'
      if (t.includes('modorganizer') || t.includes('mo2')) def = 'C:\\Modding\\MO2\\ModOrganizer.exe'
      else if (t.includes('loot')) def = 'C:\\Modding\\LOOT\\LOOT.exe'
      else if (t.includes('sseedit')) def = 'C:\\Modding\\SSEEdit\\SSEEdit.exe'
      else if (t.includes('dyndolod')) def = 'C:\\Modding\\DynDOLOD\\DynDOLODx64.exe'
      else if (t.includes('xlodgen')) def = 'C:\\Modding\\xLODGen\\xLODGenx64.exe'
      else if (t.includes('pandora')) def = 'C:\\Modding\\Pandora\\Pandora Behaviour Engine+.exe'
      else if (t.includes('wabbajack')) def = 'C:\\Modding\\modlist.wabbajack'
      try {
        return window.prompt(title ?? 'Seleziona file', def)
      } catch {
        return def
      }
    },
    readDir: async () => ({ ok: true, entries: [] }),
    revealFolder: async (kind: string) => {
      console.info('[mock] revealFolder:', kind)
      return { success: true }
    },
    openDownload: async (downloadId: number) => {
      console.info('[mock] openDownload:', downloadId)
      return { success: true }
    },
    openExternal: async (url: string) => {
      window.open(url, '_blank')
    },
  },

  tools: {
    launchMO2: ok,
    launchLOOT: ok,
    launchSSEEdit: ok,
    launchDynDOLOD: ok,
    launchPandora: async () => ({ success: true, code: 0 }),
    // Simulated 7-Zip validation: a path that names 7z/7za is "valid"; otherwise
    // pretend a standard install exists so the UX can be exercised in the browser.
    validate7z: async (path?: string) => {
      if (path && /7z|7za/i.test(path)) return { path, exists: true, valid: true, version: '24.07' }
      if (path) return { path, exists: false, valid: false, version: null }
      return { path: 'C:\\Program Files\\7-Zip\\7z.exe', exists: true, valid: true, version: '24.07' }
    },
    // Anteprima: il provisioning reale scarica dalle release GitHub (solo app desktop).
    provisionMissing: async () => ({
      results: [
        { ok: true, key: 'loot' as const, label: 'LOOT', version: '0.29.1', exePath: 'C:\\preview\\tools\\loot\\LOOT.exe' },
        { ok: true, key: 'sseedit' as const, label: 'SSEEdit (xEdit)', version: '4.1.5f', exePath: 'C:\\preview\\tools\\sseedit\\SSEEdit64.exe' },
        { ok: true, key: 'xlodgen' as const, label: 'xLODGen', version: 'v132', exePath: 'C:\\preview\\tools\\xlodgen\\xLODGenx64.exe' },
      ],
    }),
  },

  app: {
    getVersion: async () => '1.0.0',
    getUserData: async () => 'C:\\Users\\User\\AppData\\Roaming\\skyrim-ae-mod-manager',
  },

  // Steam detection + launch pre-flight — browser simulation derived from settings
  // so configuring paths/mods changes the report (demonstrates the gated launch).
  steam: {
    detect: async () => {
      const e = buildMockLaunchEnv()
      return { steam: e.steam, skyrim: e.skyrim }
    },
  },
  launch: {
    preflight: async () => runLaunchWorkflow(buildMockLaunchEnv()),
    run: async () => {
      const report = runLaunchWorkflow(buildMockLaunchEnv())
      return { launched: report.canLaunch, report }
    },
    // One-Click Play — drives the REAL active pipeline with simulated IO so the
    // browser preview streams the same staged progress the packaged app does.
    activeRun: async () =>
      runActiveLaunch({
        buildEnv: () => buildMockLaunchEnv(),
        ensureSteam: async (env) => {
          await sleep(800) // visible "starting Steam / waiting for login" pause
          if (!env.steam.installed)
            return { ok: false, loggedIn: false, started: false, timedOut: false, message: 'Steam non installato (simulazione)' }
          return {
            ok: true,
            loggedIn: true,
            started: !env.steam.running,
            timedOut: false,
            message: env.steam.running ? 'Steam già pronto' : 'Steam avviato e pronto',
          }
        },
        checkUpdate: async () => {
          await sleep(350)
          return { available: false, currentVersion: '1.0.0', latestVersion: null, error: null, checked: false }
        },
        resolveTarget: (env) => mockResolveTarget(env),
        launchExe: () => ({ success: true, pid: 4242 }),
        launchProtocol: async () => {
          await sleep(350)
          return { success: true }
        },
        onProgress: (ev) => emitLaunchProgress(ev),
        recordSuccess: (t) => {
          mockSmart = {
            ...mockSmart,
            lastBootstrapperId: t.bootstrapperId,
            lastLaunchAt: nowIso(),
            launchCount: mockSmart.launchCount + 1,
          }
        },
      }),
    onProgress: (cb: (p: unknown) => void) => {
      const listener = (p: LaunchProgress) => cb(p)
      launchListeners.add(listener)
      return () => launchListeners.delete(listener)
    },
  },
  launcher: {
    playGame: async () => ({ success: true, via: mockResolveTarget(buildMockLaunchEnv())?.bootstrapperId ?? null }),
    createShortcut: async () => ({ success: true, shortcutPath: 'C:/Users/User/Desktop/Skyrim AE Mod Manager.lnk' }),
    createAppShortcut: async () => ({ success: true, shortcutPath: 'C:/Users/User/Desktop/Skyrim AE Fantasy Launcher.lnk' }),
    checkUpdate: async () => ({ available: false, currentVersion: '1.0.0', latestVersion: null, error: null, checked: false }),
    smartConfig: async () => ({ ...mockSmart }),
    setSmartConfig: async (patch: Record<string, unknown>) => {
      mockSmart = { ...mockSmart, ...patch }
      return { ...mockSmart }
    },
  },
  // Load order (v1.1.0) — browser simulation: base masters + one .esp per installed mod.
  plugin: {
    getOrder: async () => {
      const base = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'].map(
        (name, index) => ({ name, active: true, index }),
      )
      const mods = state.mods
        .filter((m) => m.is_installed)
        .map((m, i) => ({
          name: `${m.name.replace(/[^\w .'-]/g, '').trim() || 'Mod'}.esp`,
          active: !!m.is_enabled,
          index: base.length + i,
        }))
      return [...base, ...mods]
    },
    // Browser simulation: no real filesystem — echo a success Result.
    saveOrder: async (entries: { name: string; active: boolean; index: number }[]) => ({
      success: true,
      written: Array.isArray(entries) ? entries.length : 0,
      backupPath: 'C:/Users/User/AppData/Local/Skyrim Special Edition/plugins.txt.bak',
    }),
  },

  // Vortex importer — simulated scan of two collections for the browser preview.
  // Generates a realistic ~833-mod / ~290 GB dataset so the Dashboard counters match
  // the real install; in Electron these numbers come from the actual collection.json.
  vortex: {
    scan: async () => {
      const GB = 1024 * 1024 * 1024
      const samples = [
        {
          modId: 17230,
          fileId: 489502,
          name: 'SSE Engine Fixes',
          fileSize: 8 * 1024 * 1024,
          optional: false,
          source: 'collection' as const,
          collection: 'MY MODS',
        },
        {
          modId: 32444,
          fileId: 5000,
          name: 'Address Library',
          fileSize: 3 * 1024 * 1024,
          optional: false,
          source: 'collection' as const,
          collection: 'MY MODS',
        },
        {
          modId: 22487,
          fileId: 77989,
          name: 'Community Overlays 1',
          fileSize: 51132202,
          optional: false,
          source: 'collection' as const,
          collection: 'Mon Skyril',
        },
        {
          modId: 99999,
          fileId: null,
          name: 'Loose Installed Mod',
          fileSize: 0,
          optional: false,
          source: 'folder' as const,
        },
      ]
      const gen = Array.from({ length: 829 }, (_, i) => ({
        modId: 200000 + i,
        fileId: 600000 + i,
        name: `Nexus Mod ${200000 + i}`,
        fileSize: Math.round((0.15 + (((i * 37) % 100) / 100) * 0.4) * GB), // 0.15–0.55 GB spread → ~290 GB total
        optional: i % 9 === 0,
        source: 'collection' as const,
        collection: i % 2 ? 'MY MODS' : 'Mon Skyril',
      }))
      const mods = [...samples, ...gen]
      const totalBytes = mods.reduce((a, m) => a + (m.fileSize || 0), 0)
      return {
        collections: ['Mon Skyril', 'MY MODS'],
        mods,
        folderCount: 911,
        fromCollections: 962,
        fromFolders: 1,
        duplicatesRemoved: 129,
        totalBytes,
      }
    },
    buildCatalog: async () => ({
      path: 'C:\\Users\\User\\AppData\\Roaming\\skyrim-ae-mod-manager\\vortex-catalog.json',
      total: 833,
      collections: ['Mon Skyril', 'MY MODS'],
    }),
  },

  // Compatibility engine — modlist report (T3 plugins) + runtime/SKSE version (T5).
  compat: {
    analyze: async (): Promise<CompatAnalysis> => {
      const mods = state.mods
      const compatMods: CompatMod[] = mods.map((m) => ({
        name: m.name,
        version: m.version,
        requires: m.requires,
        is_enabled: m.is_enabled,
        category: m.category,
        nexus_id: m.nexus_id,
      }))
      // ~1/3 delle mod ha un aggiornamento (stessa regola del Nexus simulato) → version drift.
      const latestVersions: Record<number, string> = {}
      for (const m of mods)
        if (m.nexus_id && m.nexus_id % 3 === 0) latestVersions[m.nexus_id] = bumpVersion(m.version)
      const plugins = derivePluginsFromMods(mods).map((p) => ({ name: p.name, enabled: p.enabled }))
      const report = analyzeModlist({ mods: compatMods, plugins, latestVersions })
      const hasSkse = mods.some((m) => /skse/i.test(m.name) && m.is_installed)
      return {
        skyrim: { version: '1.6.1170.0', installed: true },
        skse: {
          present: hasSkse,
          version: hasSkse ? '2.2.6' : null,
          gameVersion: '1.6.1170',
          gameVersionSupported: hasSkse ? true : null,
        },
        report,
        pluginSource: 'derived',
        pluginCount: plugins.length,
      }
    },
  },

  // Delta update engine — simulazione del flusso firmato ingest→check→apply→finalize.
  delta: {
    ingest: async (signed: unknown) => {
      const tag =
        (signed as { manifest?: { release_tag?: string } } | null)?.manifest?.release_tag ?? '2026.06.22'
      const reused = deltaSim.releaseId === 1
      deltaSim.releaseId = 1
      deltaSim.releaseTag = tag
      return { success: true, releaseId: 1, reused }
    },
    ingestUrl: async (url: string) => {
      // Browser: nessun fetch reale (CORS/no server). Simula il recupero remoto del
      // catalogo firmato; in Electron qui gira il fetch HTTPS reale + verifica firma.
      if (!/^https?:\/\//i.test(url)) return { success: false, error: `URL catalogo non valido: ${url}` }
      const reused = deltaSim.releaseId === 1
      deltaSim.releaseId = 1
      deltaSim.releaseTag = '2026.06-core'
      return { success: true, releaseId: 1, reused }
    },
    syncSnapshot: async (profileId: number) => ({
      rows: state.mods.filter((m) => m.is_installed && m.nexus_id != null && m.profile_id === profileId)
        .length,
      added: 0,
      removed: 0,
    }),
    checkUpdates: async (profileId: number) => {
      // Mirrors DeltaService.checkUpdates: snapshot baseline vs latest release → drift.
      const rows = buildDeltaChangeset(profileId).filter(
        (r) => r.change_type === 'added' || r.change_type === 'changed',
      )
      const counts: Record<string, number> = { added: 0, changed: 0, removed: 0, reordered: 0 }
      for (const r of rows) counts[r.change_type] = (counts[r.change_type] ?? 0) + 1
      const snapshotRows = state.mods.filter(
        (m) => m.is_installed && m.nexus_id != null && m.profile_id === profileId,
      ).length
      return {
        ok: true,
        toReleaseId: 1,
        snapshotRows,
        updates: rows.map((r) => ({
          nexus_id: r.nexus_id,
          name: r.name ?? null,
          from_version: r.from_version ?? null,
          to_version: r.to_version ?? null,
          change_type: r.change_type,
        })),
        counts,
      }
    },
    check: async (profileId: number) => {
      deltaSim.rows = buildDeltaChangeset(profileId)
      const counts: Record<string, number> = { added: 0, changed: 0, removed: 0, reordered: 0 }
      for (const r of deltaSim.rows) counts[r.change_type] = (counts[r.change_type] ?? 0) + 1
      return { ok: true, toReleaseId: 1, counts }
    },
    list: async (_profileId: number, _toReleaseId: number): Promise<DeltaChangeRow[]> => clone(deltaSim.rows),
    apply: async (profileId: number, _toReleaseId: number) => {
      let queued = 0
      for (const r of deltaSim.rows) {
        if (r.change_type === 'added' || r.change_type === 'changed') {
          state.downloads.push({
            id: state.nextDownloadId++,
            mod_id: null,
            profile_id: profileId,
            nexus_id: r.nexus_id,
            file_id: null,
            name: `Δ ${r.name}${r.to_version ? ' ' + r.to_version : ''}`,
            url: null,
            file_path: `C:\\Mods\\Delta\\${r.nexus_id}.7z`,
            total_size: 5 * 1024 * 1024,
            downloaded_size: 5 * 1024 * 1024,
            status: 'completed',
            error: null,
            created_at: nowIso(),
          })
          queued++
        }
        r.status = 'downloading'
      }
      persist()
      return { queued, total: deltaSim.rows.length }
    },
    finalize: async (profileId: number, _toReleaseId: number) => {
      let applied = 0
      for (const r of deltaSim.rows) {
        if (r.change_type === 'changed') {
          const m = state.mods.find((x) => x.nexus_id === r.nexus_id)
          if (m) {
            m.version = r.to_version
            m.updated_at = nowIso()
            applied++
          }
        } else if (r.change_type === 'added') {
          if (!state.mods.some((x) => x.nexus_id === r.nexus_id)) {
            const addedName = r.name ?? `Mod #${r.nexus_id}`
            state.mods.push({
              id: state.nextModId++,
              profile_id: profileId,
              nexus_id: r.nexus_id,
              name: addedName,
              version: r.to_version,
              author: null,
              category: (r.category as Mod['category']) ?? 'other',
              description: 'Aggiunta dal delta update',
              file_size: 5 * 1024 * 1024,
              install_path: `C:\\Mods\\${addedName}`,
              is_enabled: 1,
              is_installed: 1,
              load_order: state.mods.length + 1,
              priority: state.mods.length + 1,
              tags: '[]',
              conflicts: '[]',
              requires: '[]',
              translation_it: 0,
              nexus_url: null,
              thumbnail_url: null,
              created_at: nowIso(),
              updated_at: nowIso(),
            })
            applied++
          }
        } else if (r.change_type === 'reordered') {
          const m = state.mods.find((x) => x.nexus_id === r.nexus_id)
          if (m && r.to_load_order != null) {
            m.load_order = r.to_load_order
            applied++
          }
        }
      }
      deltaSim.rows = deltaSim.rows.map((r) => ({ ...r, status: 'applied' as const }))
      persist()
      return { committed: true, applied }
    },
    recover: async () => ({ recovered: false }),
  },

  download: {
    start: async (id: number) => {
      promoteToDownloading(id)
      return { success: true }
    },
    enqueue: async (id: number) => {
      promoteToDownloading(id)
    },
    resume: async (id: number) => {
      const d = state.downloads.find((x) => x.id === id)
      if (d) {
        d.status = 'downloading'
        d.error = null
        tickTimes[id] = Date.now()
        persist()
      }
    },
    processPending: async () => {
      let n = 0
      for (const d of state.downloads)
        if (d.status === 'pending') {
          promoteToDownloading(d.id)
          n++
        }
      return { queued: n }
    },
    pause: async (id: number) => {
      const d = state.downloads.find((x) => x.id === id)
      if (d && d.status === 'downloading') {
        d.status = 'paused'
        persist()
      }
    },
    cancel: async (id: number) => {
      state.downloads = state.downloads.filter((x) => x.id !== id)
      persist()
    },
    activeCount: async () => state.downloads.filter((d) => d.status === 'downloading').length,
  },

  install: {
    run: async (id: number) => {
      const d = state.downloads.find((x) => x.id === id)
      if (!d) return { success: false, error: 'Download non trovato' }
      d.status = 'completed'
      if (d.mod_id != null) {
        const mod = state.mods.find((m) => m.id === d.mod_id)
        if (mod) {
          mod.is_installed = 1
          mod.install_path = `C:\\Mods\\${d.name}`
        }
      }
      persist()
      return { success: true, path: `C:\\Mods\\${d.name}` }
    },
  },

  backup: {
    list: async () => clone(state.backups.map(({ snapshot: _snapshot, ...rest }) => rest)),
    create: async (profileId: number, label?: string) => {
      const mods = state.mods.filter((m) => m.profile_id === profileId)
      const name = `${label || 'profilo'}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
      const entry: BackupEntry = {
        name,
        path: `C:\\Backups\\${name}.json`,
        size: JSON.stringify(mods).length,
        date: nowIso(),
        snapshot: clone(mods),
      }
      state.backups.unshift(entry)
      state.nextBackupId++
      persist()
      return { success: true, name }
    },
    restore: async (backupPath: string, profileId: number) => {
      const entry = state.backups.find((b) => b.path === backupPath)
      if (!entry) return { success: false, restored: 0 }
      state.mods = state.mods.filter((m) => m.profile_id !== profileId)
      for (const m of entry.snapshot) state.mods.push({ ...clone(m), profile_id: profileId })
      persist()
      return { success: true, restored: entry.snapshot.length }
    },
    delete: async (backupPath: string) => {
      state.backups = state.backups.filter((b) => b.path !== backupPath)
      persist()
    },
  },

  wabbajack: {
    parse: async (_path: string, profileId: number) => {
      // Simula l'import di una piccola modlist di esempio
      const sample = [
        { name: 'Unofficial Skyrim Special Edition Patch', category: 'patch' as const },
        { name: 'SSE Engine Fixes', category: 'framework' as const },
        { name: 'Cathedral Weathers', category: 'visuals' as const },
      ]
      let imported = 0
      for (const s of sample) {
        if (state.mods.some((m) => m.name.toLowerCase() === s.name.toLowerCase())) continue
        state.mods.push({
          id: state.nextModId++,
          profile_id: profileId,
          nexus_id: null,
          name: s.name,
          version: null,
          author: null,
          category: s.category,
          description: 'Importata da Wabbajack (demo)',
          file_size: 0,
          install_path: null,
          is_enabled: 1,
          is_installed: 1,
          load_order: state.mods.length + 1,
          priority: state.mods.length + 1,
          tags: '[]',
          conflicts: '[]',
          requires: '[]',
          translation_it: 0,
          nexus_url: null,
          thumbnail_url: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        })
        imported++
      }
      persist()
      return { success: true, name: 'Demo Modlist', imported }
    },
    browseModlists: async () => ({ success: true, lists: [] }),
    export: async (profileId: number) => ({
      success: true,
      modCount: state.mods.filter((m) => m.profile_id === profileId).length,
    }),
  },

  on: (_ch: string, _fn: unknown) => {},
  off: (_ch: string, _fn: unknown) => {},
}

// ─── Iniezione (solo se non in Electron) ─────────────────────────────────────
if (typeof window !== 'undefined' && !(window as unknown as Record<string, unknown>).api) {
  ;(window as unknown as Record<string, unknown>).__mockApi__ = mockApi
  ;(window as unknown as Record<string, unknown>).api = mockApi
}
