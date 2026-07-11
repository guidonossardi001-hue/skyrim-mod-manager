import type { CompatAnalysis } from '@/lib/compatibility'

export interface Profile {
  id: number
  name: string
  description: string
  game_path: string | null
  mo2_path: string | null
  created_at: string
  updated_at: string
}

export interface Mod {
  id: number
  profile_id: number
  nexus_id: number | null
  name: string
  version: string | null
  author: string | null
  category: ModCategory
  description: string | null
  file_size: number
  install_path: string | null
  is_enabled: 0 | 1
  is_installed: 0 | 1
  load_order: number
  priority: number
  tags: string
  conflicts: string
  requires: string
  translation_it: 0 | 1
  nexus_url: string | null
  thumbnail_url: string | null
  created_at: string
  updated_at: string
}

export type ModCategory =
  | 'framework'
  | 'visuals'
  | 'character'
  | 'npc'
  | 'gameplay'
  | 'combat'
  | 'animation'
  | 'audio'
  | 'quest'
  | 'world'
  | 'lore'
  | 'ui'
  | 'performance'
  | 'adult'
  | 'translation'
  | 'patch'
  | 'tool'
  | 'other'

export interface CatalogMod {
  id: number
  nexus_id: number
  name: string
  category: ModCategory
  subcategory: string | null
  priority_order: number
  required: 0 | 1
  description: string | null
  author: string | null
  tags: string
  size_mb: number
  has_it_translation: 0 | 1
  notes: string | null
  conflicts_with: string
  requires: string
}

export interface Download {
  id: number
  mod_id: number | null
  profile_id: number
  nexus_id: number | null
  file_id: number | null
  name: string
  url: string | null
  file_path: string | null
  total_size: number
  downloaded_size: number
  status: DownloadStatus
  error: string | null
  created_at: string
}

export type DownloadStatus = 'pending' | 'downloading' | 'paused' | 'completed' | 'failed' | 'installing'

export interface AppSettings {
  nexusApiKey?: string
  nexusEnabled?: boolean // opt-in: activate the real Nexus HTTP provider + download_link (Premium)
  catalogUrl?: string // remote signed-catalog URL (Act-03); empty → bundled artifact
  gamePath?: string
  stockGameSource?: string // override for the vanilla Skyrim source (default: detected Steam install)
  stockGamePath?: string // target folder for the isolated StockGame copy
  mo2Path?: string
  modsPath?: string
  sevenZipPath?: string
  lootPath?: string
  sseeditPath?: string
  dyndolodPath?: string
  xlodgenPath?: string
  pandoraPath?: string
  vortexPath?: string // override for the Vortex skyrimse/mods staging folder
  autoSyncOnLaunch?: boolean // opt-in: run the full Sync pipeline automatically on app open
  activeProfileId?: number
  language: 'it' | 'en'
  theme: 'dark'
  autoSort: boolean
  checkConflicts: boolean
  autoBackup: boolean
  downloadThreads: number
  downloadRetries?: number
  errorThreshold?: number
}

export interface ConflictInfo {
  modId: number
  modName: string
  conflictType: 'overwrite' | 'missing-master' | 'incompatible' | 'version'
  severity: 'warning' | 'error'
  message: string
}

export interface InstallProgress {
  modId: number
  modName: string
  stage: 'downloading' | 'extracting' | 'installing' | 'patching' | 'done' | 'error'
  percent: number
  message: string
}

// Load order (v1.1.0 "Conflict & Load Order"): one entry per plugin Skyrim reads,
// merged from the game's real plugins.txt (AppData/Local) + the .esp/.esm/.esl
// files on disk. `index` is the 0-based position in the effective load order.
// Distinct from lib/plugins.ts `Plugin` (derived from the mod set) — this reflects
// the actual game state.
export interface LoadOrderEntry {
  name: string
  active: boolean
  index: number
}

// Window API type (injected by preload)
declare global {
  interface Window {
    api: {
      window: {
        minimize(): Promise<void>
        maximize(): Promise<void>
        close(): Promise<void>
        isMaximized(): Promise<boolean>
      }
      settings: {
        get(key: string): Promise<unknown>
        set(key: string, value: unknown): Promise<void>
        getAll(): Promise<Record<string, unknown>>
        autoDetect(): Promise<{
          ok: boolean
          detected: Partial<AppSettings>
          applied: Partial<AppSettings>
          error?: string
        }>
      }
      profiles: {
        list(): Promise<Profile[]>
        create(data: { name: string; description?: string }): Promise<Profile>
        update(id: number, data: Partial<Profile>): Promise<Profile>
        delete(id: number): Promise<void>
      }
      mods: {
        list(profileId: number): Promise<Mod[]>
        add(data: Partial<Mod>): Promise<Mod>
        addMany(rows: Partial<Mod>[]): Promise<{ inserted: number }>
        update(id: number, data: Partial<Mod>): Promise<Mod>
        delete(id: number): Promise<void>
        reorder(profileId: number, orderedIds: number[]): Promise<void>
      }
      catalog: {
        list(filter?: { category?: string; search?: string }): Promise<CatalogMod[]>
        seed(mods: Partial<CatalogMod>[]): Promise<{ inserted: number }>
        // Fetch + verify + atomically replace the reference catalog from the
        // signed remote source. url is optional (main process falls back to its
        // configured default). Never rejects — inspect success/errorKind.
        update(url?: string): Promise<{
          success: boolean
          version?: number
          inserted?: number
          reused?: boolean
          error?: string
          errorKind?: 'parse' | 'schema' | 'integrity' | 'signature' | 'downgrade' | 'db' | 'network'
        }>
        // Dependency-first install plan for the given targets. Never rejects —
        // inspect success/errorKind. Mirrors electron/catalog/dependencies.ts
        // InstallPlanResult (kept in sync by hand: the two tsconfigs are separate
        // projects, so the renderer never imports from electron/).
        resolvePlan(
          targetIds: number[],
          installedIds: number[],
        ): Promise<{
          success: boolean
          plan?: Array<{
            nexus_id: number
            name: string
            priority_order: number
            reason: 'target' | 'dependency'
          }>
          errorKind?: 'missing' | 'cycle' | 'conflict' | 'db'
          errors?: string[]
          cyclePath?: number[]
          conflicts?: Array<{
            mod: number
            modName: string
            conflictsWith: number
            offender: 'installed' | 'planned'
          }>
          // File-override collisions the system auto-resolved (category/weight/
          // priority rules) — informational, never a blocker. See ResolvedConflict
          // in electron/deploy/plan.ts.
          resolvedConflicts?: Array<{
            file: string
            winner: string
            loser: string
          }>
        }>
      }
      downloads: {
        list(profileId: number): Promise<Download[]>
        add(data: Partial<Download>): Promise<number>
        updateStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<void>
      }
      nexus: {
        // The API key lives ONLY in the main process (encrypted secret store);
        // validateKey may pass a just-typed candidate not yet saved.
        getMod(nexusId: number): Promise<{ success: boolean; data?: unknown; error?: string }>
        validateKey(apiKey?: string): Promise<{ success: boolean; data?: unknown }>
      }
      fs: {
        pickDirectory(title?: string): Promise<string | null>
        pickFile(title?: string, filters?: unknown[]): Promise<string | null>
        exists(path: string): Promise<boolean>
        readDir(
          path: string,
        ): Promise<Array<{ name: string; path: string; isDirectory: boolean; size: number }>>
        openPath(path: string): Promise<void>
        openExternal(url: string): Promise<void>
      }
      tools: {
        // Executable paths are resolved MAIN-side from the settings store:
        // the renderer can no longer pass an arbitrary exe over IPC.
        launchMO2(): Promise<{ success: boolean; error?: string }>
        launchLOOT(): Promise<{ success: boolean; error?: string }>
        launchSSEEdit(): Promise<{ success: boolean; error?: string }>
        launchDynDOLOD(): Promise<{ success: boolean; error?: string }>
        launchPandora(): Promise<{ success: boolean; code?: number; error?: string }>
        validate7z(
          path?: string,
        ): Promise<{ path: string | null; exists: boolean; valid: boolean; version: string | null }>
        pandoraPath(): Promise<{
          path: string | null
          exePath: string | null
          exeFound: boolean
          candidatesTried: string[]
        }>
      }
      vortex: {
        scan(): Promise<VortexScanResult>
        buildCatalog(): Promise<{ path: string; total: number; collections: string[] }>
      }
      app: {
        getVersion(): Promise<string>
        getUserData(): Promise<string>
      }
      // Install pipeline (verify → staged extract → recipe map → atomic commit).
      // Never rejects — inspect success/errorKind. Mirrors the InstallResult in
      // electron/install/installer.ts (kept in sync by hand: separate tsconfigs,
      // so the renderer never imports from electron/).
      install: {
        run(downloadId: number): Promise<{
          success: boolean
          nexusId: number
          modPath?: string
          strategy?: 'root' | 'recipe'
          recipeSource?: 'exact' | 'nexus' | 'default'
          filesDeployed?: number
          method?: '7z' | '7za' | 'zip'
          recipeSchema?: number
          errorKind?:
            | 'not-found'
            | 'hash'
            | 'disk-space'
            | 'extract'
            | 'recipe'
            | 'recipe-slip'
            | 'commit'
            | 'cancelled'
            | 'db'
          error?: string
        }>
      }
      // Deploy/virtualization: link a profile's enabled mods into its instance Data
      // folder. Never rejects — inspect success/errorKind. Mirrors DeployResult in
      // electron/deploy/deployer.ts (kept in sync by hand: separate tsconfigs, so
      // the renderer never imports from electron/).
      deploy: {
        run(profileId: number): Promise<{
          success: boolean
          instanceDataDir?: string
          modsLinked?: number
          filesHardlinked?: number
          junctionsCreated?: number
          pluginsWritten?: number
          pluginsPath?: string
          errorKind?: 'no-mods' | 'cross-volume' | 'source-missing' | 'cleanup' | 'link' | 'db'
          error?: string
        }>
        // Streamed progress. Mirrors DeployProgress in electron/deploy/deployer.ts.
        // Returns an unsubscribe function — call it on unmount to detach the listener.
        onProgress(
          callback: (p: {
            stage: 'scanning' | 'cleaning' | 'linking' | 'plugins' | 'done'
            currentMod?: string
            currentFile?: string
            processedItems?: number
            totalItems?: number
            percent?: number
          }) => void,
        ): () => void
      }
      // Incremental (delta) update engine — signed-manifest ingest + gated apply.
      delta: {
        ingest(
          signedManifest: unknown,
        ): Promise<{ success: boolean; releaseId?: number; reused?: boolean; error?: string }>
        ingestUrl(
          url: string,
        ): Promise<{ success: boolean; releaseId?: number; reused?: boolean; error?: string }>
        syncSnapshot(profileId: number): Promise<{ rows: number; added: number; removed: number }>
        checkUpdates(profileId: number): Promise<DeltaCheckUpdates>
        check(
          profileId: number,
        ): Promise<{ ok: boolean; toReleaseId?: number; counts?: Record<string, number>; error?: string }>
        list(profileId: number, toReleaseId: number): Promise<DeltaChangeRow[]>
        apply(profileId: number, toReleaseId: number): Promise<{ queued: number; total: number }>
        finalize(
          profileId: number,
          toReleaseId: number,
        ): Promise<{ committed?: boolean; applied?: number; [k: string]: unknown }>
        recover(): Promise<{ recovered?: boolean; [k: string]: unknown }>
      }
      // Compatibility engine — runtime/SKSE version + plugins.txt modlist report.
      compat: {
        analyze(): Promise<CompatAnalysis>
      }
      // Load order (v1.1.0) — reads the game's real plugins.txt + Data/ scan.
      plugin: {
        getOrder(): Promise<LoadOrderEntry[]>
      }
      // StockGame builder — isolated vanilla copy (companion-safe, read-only source).
      stockGame: {
        detect(): Promise<StockGameDetect>
        create(opts?: { mode?: 'hardlink' | 'copy' }): Promise<StockGameResult>
      }
      // Mass-sync — drive the whole modlist into the isolated StockGame.
      sync: {
        start(opts?: {
          concurrency?: number
          limit?: number
        }): Promise<{ ok: boolean; total?: number; stockGameDir?: string; error?: string }>
        cancel(): Promise<{ ok: boolean }>
        status(): Promise<SyncProgressUI | null>
        preflight(opts?: { limit?: number }): Promise<DiskPreflightUI>
      }
    }
  }
}

// Aggregate disk pre-flight (PRECHECK-01) result for the Dashboard GO/NO-GO readout.
export interface DiskPreflightUI {
  pendingBytes: number
  extractionOverhead: number
  safetyFactor: number
  requiredBytes: number
  freeBytes: number
  marginBytes: number
  ok: boolean
  stockGameDir: string
  modsTotal: number
  /** Mod effettivamente selezionate per il run pianificato (blocco Run-Prog). */
  modsSelected?: number
}

// Live mass-sync progress pushed on the 'sync:progress' channel.
export interface SyncProgressUI {
  phase: 'preparing' | 'syncing' | 'done' | 'cancelled' | 'error'
  modsTotal: number
  modsDone: number
  modsFailed: number
  modsSkipped: number
  bytesDownloaded: number
  bytesTotal: number
  throughputMBps: number
  etaSeconds: number | null
  active: {
    name: string
    phase: 'downloading' | 'verifying' | 'extracting'
    downloaded: number
    total: number
    percent: number
  }[]
  lastMessage?: string
}

// StockGame detect/create shapes (mirror electron/install/stockGame.ts).
export interface StockGameDetect {
  source: string | null
  target: string
  plan: { files: number; totalBytes: number; skippedFiles: number; skippedBytes: number } | null
  error?: string
}
export interface StockGameProgress {
  phase: 'scanning' | 'copying' | 'verifying' | 'done'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  currentFile?: string
}
export interface StockGameResult {
  targetDir: string
  mode: 'hardlink' | 'copy'
  filesTotal: number
  bytesTotal: number
  hardlinked: number
  copied: number
  alreadyPresent: number
  skippedFiles: number
  skippedBytes: number
  missingRequired: string[]
}

// Per-mod version drift returned by the delta engine's checkUpdates (installed
// snapshot vs latest ingested signed release).
export interface DeltaUpdate {
  nexus_id: number
  name: string | null
  from_version: string | null
  to_version: string | null
  change_type: string
}

export interface DeltaCheckUpdates {
  ok: boolean
  toReleaseId?: number
  snapshotRows: number
  updates: DeltaUpdate[]
  counts: Record<string, number>
  error?: string
}

// Vortex importer result (read-only scan of an existing Vortex staging folder).
export interface VortexScanMod {
  modId: number
  fileId: number | null
  name: string
  fileSize?: number
  md5?: string
  optional: boolean
  phase?: number
  source: 'collection' | 'folder'
  collection?: string
}
export interface VortexScanResult {
  collections: string[]
  mods: VortexScanMod[]
  folderCount: number
  fromCollections: number
  fromFolders: number
  duplicatesRemoved: number
  totalBytes: number
}

// Row shape consumed by the Updates page — a structural superset compatible with
// both the real DeltaRow (journal) and the browser-mock changeset.
export interface DeltaChangeRow {
  id: number
  nexus_id: number
  change_type: string
  name?: string
  from_version?: string | null
  to_version: string | null
  to_file_name: string | null
  to_load_order?: number | null
  status: string
}
