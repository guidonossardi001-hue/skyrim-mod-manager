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
  /** File primario Nexus: con nexus_id forma la coppia che rende DERIVABILE il link diretto.
   *  Assente nel seed curato bundled (che infatti NON è scaricabile senza backfill dal backup). */
  nexus_file_id?: number | null
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

export type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'installing'

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
  textureQualityProfile?: '2K' | '4K' // mass-installer texture quality/space profile (default 4K)
  enableAutoTranslate?: boolean // mass-installer: auto-apply the ITA translation overlay (default ON)
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

// Result of writing the load order back to plugins.txt (v1.1.0 Milestone 2).
export interface SaveLoadOrderResult {
  success: boolean
  written: number
  backupPath: string | null
  error?: string
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
        seed(mods: Partial<CatalogMod>[]): Promise<{ inserted: number; disabled?: boolean }>
        // Import the full de-duplicated modlist (~4568 mods) from the Vortex backup into the
        // catalog without clobbering curated rows. Never rejects — inspect success.
        importVortex(): Promise<{
          success: boolean
          candidates?: number
          imported?: number
          deduped?: number
          total?: number
          error?: string
        }>
        // Import diretto da Nexus Collections v2 (fonte ufficiale, modId/fileId autoritativi).
        // `input` = slug nudo o URL pagina collezione. Never rejects — inspect success.
        importNexusCollection(input: string): Promise<{
          success: boolean
          collectionName?: string
          revisionNumber?: number
          candidates?: number
          imported?: number
          deduped?: number
          total?: number
          error?: string
        }>
        // Remove cross-source name duplicates from the catalog. Never rejects.
        dedupe(): Promise<{ success: boolean; removed?: number; total?: number; error?: string }>
        // Svuotamento TOTALE: catalogo + coda download + mods del profilo; spegne l'auto-seed
        // del bundle finché un import esplicito non lo riattiva. Never rejects — inspect ok.
        wipe(): Promise<{
          ok: boolean
          catalog?: number
          downloads?: number
          mods?: number
          releases?: number
          error?: string
        }>
        // Piano/esecuzione pruning collezione (dry-run senza apply=true). Rimuove solo le mod
        // ESCLUSIVE della collezione, tenendo quelle richieste dai superstiti (no missing masters).
        pruneCollection(
          query: string,
          apply?: boolean,
        ): Promise<{
          ok: boolean
          applied?: boolean
          collection?: string
          exclusive?: number
          shared?: number
          keptAsDependency?: number
          pruned?: number
          catalogRowsDeleted?: number
          downloadsDeleted?: number
          error?: string
        }>
        // Data-integrity check dello schema download (fail-safe: flagga, non cancella).
        validateDownloads(): Promise<{
          ok: boolean
          backfilled?: number
          queue?: {
            total: number
            valid: number
            invalidCount: number
            warningCount: number
            invalid: Array<{ modId: number | null; name: string; issues: string[] }>
            warnings: Array<{ modId: number | null; name: string; issues: string[] }>
          } | null
          catalog?: {
            checked: number
            ok: number
            missingUrlCount: number
            badModIdCount: number
            missingUrl: Array<{ nexus_id: number | null; name: string }>
          } | null
        }>
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
        // Riprova in blocco tutti i download falliti (la cache archivi viene riusata).
        retryFailed(): Promise<{ retried: number }>
      }
      nexus: {
        // The API key lives ONLY in the main process (encrypted secret store);
        // validateKey may pass a just-typed candidate not yet saved.
        getMod(nexusId: number): Promise<{ success: boolean; data?: unknown; error?: string }>
        validateKey(apiKey?: string): Promise<{ success: boolean; data?: unknown }>
      }
      // nxm:// consent gate — the renderer only ever sees the id/name of a pending request
      // (never the non-premium key) and approves/rejects it by token.
      nxm: {
        listPending(): Promise<
          Array<{
            token: string
            game: string
            modId: number
            fileId: number
            hasKey: boolean
            name?: string
            receivedAt: number
          }>
        >
        approve(token: string): Promise<{ ok: boolean; id?: number; error?: string }>
        reject(token: string): Promise<{ ok: boolean }>
      }
      fs: {
        pickDirectory(title?: string): Promise<string | null>
        pickFile(title?: string, filters?: unknown[]): Promise<string | null>
        readDir(
          kind: string,
          subpath?: string,
        ): Promise<{
          ok: boolean
          error?: string
          entries: Array<{ name: string; isDirectory: boolean; size: number }>
        }>
        revealFolder(kind: string): Promise<{ success: boolean; error?: string }>
        openDownload(downloadId: number): Promise<{ success: boolean; error?: string }>
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
          systemPluginsPath?: string
          ccFilesLinked?: number
          conflictsResolved?: number
          dirtyPlugins?: { plugin: string; itm: number; udr: number; nav: number; util: string }[]
          errorKind?:
            | 'no-mods'
            | 'cross-volume'
            | 'source-missing'
            | 'dependency-cycle'
            | 'missing-master'
            | 'cleanup'
            | 'link'
            | 'db'
          error?: string
        }>
        // Purge manifest-based: rimuove SOLO ciò che il deploy ha creato (hardlink/junction
        // registrati) e ripristina il plugins.txt di sistema dal backup. Never rejects.
        purge(profileId: number): Promise<{
          success: boolean
          manifestFound: boolean
          filesRemoved: number
          junctionsRemoved: number
          dirsPruned: number
          skipped: number
          systemPluginsRestored: boolean
          error?: string
        }>
        // Dry-run: conflitti file reali + budget plugin + problemi load order, zero scritture.
        preview(profileId: number): Promise<{
          ok: boolean
          modsScanned?: number
          conflicts?: { file: string; winner: string; loser: string }[]
          pluginBudget?: { full: number; light: number; maxFull: number }
          loadOrderIssue?: string | null
          warnings?: string[]
          error?: string
        }>
        // Risoluzione avanzata: preferredMod vince i file contesi con overMod (peso+1).
        prefer(
          profileId: number,
          preferredMod: string,
          overMod: string,
        ): Promise<{ ok: boolean; newWeight?: number; error?: string }>
        // Streamed progress. Mirrors DeployProgress in electron/deploy/deployer.ts.
        // Returns an unsubscribe function — call it on unmount to detach the listener.
        onProgress(
          callback: (p: {
            stage: 'scanning' | 'cleaning' | 'linking' | 'plugins' | 'ini' | 'done'
            currentMod?: string
            currentFile?: string
            processedItems?: number
            totalItems?: number
            percent?: number
          }) => void,
        ): () => void
      }
      // Masterlist LOOT reale (community-curata): regole "after", rank di gruppo, CRC dirty-plugin.
      // Never rejects — inspect ok.
      masterlist: {
        // Fetch ESPLICITO dal repo pubblico loot/skyrimse (mai automatico al boot).
        refresh(): Promise<{
          ok: boolean
          pluginCount?: number
          groupCount?: number
          ruleCount?: number
          dirtyCount?: number
          fetchedAt?: string
          error?: string
        }>
        // Legge SOLO la cache locale (mai la rete).
        status(): Promise<{
          ok: boolean
          cached: boolean
          pluginCount?: number
          groupCount?: number
          ruleCount?: number
          dirtyCount?: number
          fetchedAt?: string
        }>
      }
      // Preset ENB: scan nelle mod estratte, apply/remove nella ROOT del gioco. Never rejects.
      enb: {
        scan(): Promise<{
          ok: boolean
          presets: { modName: string; presetDir: string; label: string; files: number; hasCoreDll: boolean }[]
        }>
        apply(
          presetDir: string,
          label: string,
        ): Promise<{
          ok: boolean
          applied?: number
          backedUp?: number
          coreDllPresent?: boolean
          removedPrevious?: boolean
          error?: string
        }>
        remove(): Promise<{ ok: boolean; removed: number; restored: number; error?: string }>
      }
      // Analizzatore crash log (Crash Logger SSE/AE/VR, Trainwreck): sola lettura.
      crash: {
        listRecent(): Promise<{
          ok: boolean
          dir?: string
          entries?: { name: string; path: string; mtimeMs: number; size: number }[]
          error?: string
        }>
        analyze(filePath: string): Promise<{
          ok: boolean
          report?: {
            gameVersion: string | null
            crashLoggerVersion: string | null
            exceptionType: string | null
            exceptionModule: string | null
            callStack: { index: number; address: string; module: string; offset: string; instruction: string | null }[]
            ssePlugins: { name: string; version: string | null }[]
            plugins: string[]
            recognized: boolean
          }
          analysis?: {
            culprit: { index: number; address: string; module: string; offset: string; instruction: string | null } | null
            suggestions: string[]
          }
          rawExcerpt?: string
          error?: string
        }>
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
      // Load order (v1.1.0) — reads the game's real plugins.txt + Data/ scan (get)
      // and writes it back with a backup (save).
      plugin: {
        getOrder(): Promise<LoadOrderEntry[]>
        saveOrder(entries: LoadOrderEntry[]): Promise<SaveLoadOrderResult>
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
        }): Promise<{
          ok: boolean
          total?: number
          stockGameDir?: string
          error?: string
          disk?: DiskErrorUI // present when the pre-flight gatekeeper blocked the run
        }>
        cancel(): Promise<{ ok: boolean }>
        status(): Promise<SyncProgressUI | null>
        preflight(opts?: { limit?: number }): Promise<DiskPreflightUI>
        // Registra le estrazioni StockGame esistenti come mod installate del profilo attivo
        // (ponte verso il Deploy). Never rejects — inspect ok.
        registerInstalled(): Promise<{
          ok: boolean
          found?: number
          inserted?: number
          updated?: number
          unchanged?: number
          error?: string
        }>
      }
    }
  }
}

// Aggregate disk pre-flight result for the Dashboard GO/NO-GO readout. Since the PRECHECK-02
// unification this is computed by the SAME pipeline as the start gate (dependency-expanded,
// translation-aware, fail-closed), so the card and the gate banner always agree.
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
  /** Verdetto unificato del gate: perché è NO-GO (assente su risposte di build vecchie). */
  reason?: 'ok' | 'insufficient' | 'unsized' | 'unreadable'
  missingBytes?: number
  unsizedCount?: number
  extraDeps?: number
  savingBytes?: number
  translationBytes?: number
  /** true quando il blocco viene dal volume della cache download (cross-disk), non dallo StockGame. */
  cacheDisk?: boolean
}

// Emitted on 'sync:disk-error' (and returned by sync.start as `disk`) when the pre-flight
// gatekeeper blocks the run because free space can't hold the dependency-expanded footprint.
export interface DiskErrorUI {
  reason: 'insufficient' | 'unsized' | 'unreadable'
  requiredBytes: number
  requiredWithBufferBytes: number
  freeBytes: number
  missingBytes: number
  savingBytes: number
  requiredGB: string
  freeGB: string
  missingGB: string
  profile: '2K' | '4K'
  pendingMods: number
  extraDeps: number
  unsizedCount: number
  sameDisk: boolean
  /** true = il blocco viene dal volume della cache download (cross-disk), non dallo StockGame. */
  cacheDisk?: boolean
  downloadsFreeBytes?: number | null
  downloadsRequiredBytes?: number
  error?: string // human-readable message (also the sync.start return `error`)
}

// Emitted on 'sync:plugin-budget' after a mass-sync run: ESL/254 launchability verdict over the
// installed StockGame/mods tree (+ the 5 vanilla full masters reserved outside the scan).
export interface PluginBudgetUI {
  full: number
  light: number
  total: number
  limit: number
  reservedSlots: number
  overBudget: boolean
  remaining: number
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
