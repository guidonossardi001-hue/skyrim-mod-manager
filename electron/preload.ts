import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

// Event channels the renderer may subscribe to. on()/off() refuse anything else,
// so the bridge can't be used to listen on arbitrary internal ipcRenderer traffic.
const EVENT_CHANNELS = new Set([
  'download:progress',
  'download:complete',
  'download:error',
  'download:queue-halted',
  'install:progress',
  'install:complete',
  'install:error',
  'sync:progress',
  'sync:disk-error',
  'sync:plugin-budget',
  'stockgame:progress',
  'deploy:progress',
  'launch:progress',
  'nxm:queued',
  'nxm:confirm-request',
])

// original listener → ipcRenderer wrapper, so off() accepts either one.
const wrappers = new WeakMap<
  (...args: unknown[]) => void,
  (event: IpcRendererEvent, ...args: unknown[]) => void
>()

contextBridge.exposeInMainWorld('api', {
  // Window
  window: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:is-maximized'),
  },

  // Settings
  settings: {
    get: (key: string) => invoke('settings:get', key),
    set: (key: string, value: unknown) => invoke('settings:set', key, value),
    getAll: () => invoke('settings:get-all'),
    autoDetect: () => invoke('settings:auto-detect'),
  },

  // Profiles
  profiles: {
    list: () => invoke('profiles:list'),
    create: (data: { name: string; description?: string }) => invoke('profiles:create', data),
    update: (id: number, data: Record<string, unknown>) => invoke('profiles:update', id, data),
    delete: (id: number) => invoke('profiles:delete', id),
  },

  // Mods
  mods: {
    list: (profileId: number) => invoke('mods:list', profileId),
    add: (data: Record<string, unknown>) => invoke('mods:add', data),
    addMany: (rows: Record<string, unknown>[]) => invoke('mods:add-many', rows),
    update: (id: number, data: Record<string, unknown>) => invoke('mods:update', id, data),
    delete: (id: number) => invoke('mods:delete', id),
    reorder: (profileId: number, orderedIds: number[]) => invoke('mods:reorder', profileId, orderedIds),
  },

  // Catalog
  catalog: {
    list: (filter?: { category?: string; search?: string }) => invoke('catalog:list', filter),
    seed: (mods: unknown[]) => invoke('catalog:seed', mods),
    // Import the full de-duplicated modlist (~4568 mods) from the Vortex backup into the
    // catalog, without overwriting curated rows. Resolves to { success, imported, total, ... }.
    importVortex: () => invoke('catalog:import-vortex'),
    // Piano/esecuzione pruning di una collezione (dry-run senza apply). Vedi collectionPrune.ts.
    pruneCollection: (query: string, apply?: boolean) => invoke('catalog:prune-collection', query, apply),
    // Data-integrity check schema download (coda + catalogo, fail-safe: flagga, non cancella).
    validateDownloads: () => invoke('catalog:validate-downloads'),
    // Remove cross-source name duplicates (curated placeholder-id row vs the Vortex real-id row).
    dedupe: () => invoke('catalog:dedupe'),
    // Fetch the signed reference catalog (URL optional — falls back to the
    // main-process NOLVUS_MOD_CATALOG_URL config) and ingest it. Always resolves
    // to a CatalogIngestResult, never rejects (no-throw boundary end to end).
    update: (url?: string) => invoke('catalog:update', url),
    // Compute a dependency-first install plan for the given targets. Always
    // resolves to an InstallPlanResult (success + plan, or errorKind + details).
    resolvePlan: (targetIds: number[], installedIds: number[]) =>
      invoke('catalog:resolve-plan', targetIds, installedIds),
  },

  // Downloads
  downloads: {
    list: (profileId: number) => invoke('downloads:list', profileId),
    add: (data: Record<string, unknown>) => invoke('downloads:add', data),
    updateStatus: (id: number, status: string, extra?: Record<string, unknown>) =>
      invoke('downloads:update-status', id, status, extra),
  },

  // Nexus — the API key never travels over this bridge: the main process reads it
  // from its encrypted secret store. validateKey may pass a just-typed candidate.
  nexus: {
    getMod: (nexusId: number) => invoke('nexus:get-mod', nexusId),
    validateKey: (apiKey?: string) => invoke('nexus:validate-key', apiKey),
  },

  // nxm:// consent gate. An nxm:// link never downloads on its own — the main process holds
  // it as a pending request; the renderer lists them and approves/rejects by token. Subscribe
  // to the 'nxm:confirm-request' event (via on/off) to know when to (re)load the list.
  nxm: {
    listPending: () => invoke('nxm:list-pending'),
    approve: (token: string) => invoke('nxm:approve', token),
    reject: (token: string) => invoke('nxm:reject', token),
  },

  // File system
  fs: {
    pickDirectory: (title?: string) => invoke('fs:pick-directory', title),
    pickFile: (title?: string, filters?: unknown[]) => invoke('fs:pick-file', title, filters),
    // Intent-based listing: name a whitelisted folder `kind` (+ optional relative subpath),
    // never a raw path. The main process confines the read to that root (../ + symlink safe).
    readDir: (kind: string, subpath?: string) => invoke('fs:read-dir', kind, subpath),
    // Intent-based opening: the renderer names a whitelisted folder `kind` or a numeric
    // download id — never a raw path. The main process resolves the concrete path, so a
    // compromised renderer cannot open (or execute) an arbitrary local file.
    revealFolder: (kind: string) => invoke('fs:reveal-folder', kind),
    openDownload: (downloadId: number) => invoke('fs:open-download', downloadId),
    openExternal: (url: string) => invoke('fs:open-external', url),
  },

  // External tools — the renderer picks the tool, the MAIN process resolves the
  // executable from the settings store (no exe paths accepted over IPC).
  tools: {
    launchMO2: () => invoke('tools:launch-mo2'),
    launchLOOT: () => invoke('tools:launch-loot'),
    launchSSEEdit: () => invoke('tools:launch-sseedit'),
    launchDynDOLOD: () => invoke('tools:launch-dyndolod'),
    launchPandora: () => invoke('tools:launch-pandora'),
    validate7z: (path?: string) => invoke('tools:validate-7z', path),
    pandoraPath: () => invoke('tools:pandora:path'),
  },

  // Vortex importer (read-only scan of an existing Vortex Skyrim SE staging folder)
  vortex: {
    scan: () => invoke('vortex:scan'),
    buildCatalog: () => invoke('vortex:build-catalog'),
  },

  // App
  app: {
    getVersion: () => invoke('app:get-version'),
    getUserData: () => invoke('app:get-user-data'),
  },

  // Steam detection + launch pre-flight (companion mode)
  steam: {
    detect: () => invoke('steam:detect'),
  },
  launch: {
    preflight: () => invoke('launch:preflight'),
    run: () => invoke('launch:run'),
    // One-Click Play: full active pipeline (Steam auto-start + login + bootstrap).
    activeRun: () => invoke('launch:active-run'),
    // Subscribe to streamed stage progress. Returns an unsubscribe function.
    onProgress: (callback: (p: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, p: unknown) => callback(p)
      ipcRenderer.on('launch:progress', listener)
      return () => ipcRenderer.removeListener('launch:progress', listener)
    },
  },
  // Modded game launcher (Nolvus/MO2-style): direct play + desktop shortcut +
  // smart-startup memory + self-update. No path travels over this bridge — the
  // main process resolves the bootstrap target from the settings store.
  launcher: {
    playGame: () => invoke('launcher:playGame'),
    createShortcut: () => invoke('launcher:createShortcut'),
    createAppShortcut: () => invoke('launcher:createAppShortcut'),
    checkUpdate: () => invoke('launcher:checkUpdate'),
    smartConfig: () => invoke('launcher:smartConfig'),
    setSmartConfig: (patch: Record<string, unknown>) => invoke('launcher:smartConfig:set', patch),
  },
  compat: {
    analyze: () => invoke('compat:analyze'),
  },
  // Load order (v1.1.0): read the effective plugin order Skyrim reads, and write
  // it back to plugins.txt (backed up first, atomic, no-throw).
  plugin: {
    getOrder: () => invoke('plugin:get-order'),
    saveOrder: (entries: unknown) => invoke('plugin:save-order', entries),
  },

  // Download manager
  download: {
    start: (id: number) => invoke('download:start', id),
    enqueue: (id: number) => invoke('download:enqueue', id),
    resume: (id: number) => invoke('download:resume', id),
    processPending: () => invoke('download:process-pending'),
    pause: (id: number) => invoke('download:pause', id),
    cancel: (id: number) => invoke('download:cancel', id),
    activeCount: () => invoke('download:active-count'),
  },

  // Install pipeline (extraction + deploy into the mods folder)
  install: {
    run: (downloadId: number) => invoke('install:run', downloadId),
  },

  // Deploy/virtualization: link a profile's enabled mods into its instance Data
  // folder (hardlinks + junctions). Always resolves to a DeployResult, never rejects.
  deploy: {
    run: (profileId: number) => invoke('deploy:run', profileId),
    // Purge manifest-based: rimuove gli hardlink/junction creati dal deploy e ripristina il
    // plugins.txt di sistema dal backup. L'istanza torna vuota, le sorgenti mai toccate.
    purge: (profileId: number) => invoke('deploy:purge', profileId),
    // Subscribe to streamed progress. Returns an unsubscribe function so the
    // renderer can detach the listener (avoids leaks across re-renders/unmounts).
    onProgress: (callback: (p: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, p: unknown) => callback(p)
      ipcRenderer.on('deploy:progress', listener)
      return () => ipcRenderer.removeListener('deploy:progress', listener)
    },
  },

  // StockGame builder (isolated vanilla copy; companion-safe, read-only on source)
  stockGame: {
    detect: () => invoke('stockgame:detect'),
    create: (opts?: { mode?: 'hardlink' | 'copy' }) => invoke('stockgame:create', opts),
  },

  // Mass-sync — drive the whole modlist (backup) into the isolated StockGame
  sync: {
    start: (opts?: { concurrency?: number; limit?: number }) => invoke('sync:start', opts),
    cancel: () => invoke('sync:cancel'),
    status: () => invoke('sync:status'),
    preflight: (opts?: { limit?: number }) => invoke('sync:preflight', opts),
  },

  // Incremental (delta) update engine — signed-manifest ingest + gated apply
  delta: {
    ingest: (signedManifest: unknown) => invoke('delta:ingest', signedManifest),
    ingestUrl: (url: string) => invoke('delta:ingest-url', url),
    syncSnapshot: (profileId: number) => invoke('delta:sync-snapshot', profileId),
    checkUpdates: (profileId: number) => invoke('delta:check-updates', profileId),
    check: (profileId: number) => invoke('delta:check', profileId),
    list: (profileId: number, toReleaseId: number) => invoke('delta:list', profileId, toReleaseId),
    apply: (profileId: number, toReleaseId: number) => invoke('delta:apply', profileId, toReleaseId),
    finalize: (profileId: number, toReleaseId: number) => invoke('delta:finalize', profileId, toReleaseId),
    recover: () => invoke('delta:recover'),
  },

  // Backup
  backup: {
    list: () => invoke('backup:list'),
    create: (profileId: number, label?: string) => invoke('backup:create', profileId, label),
    restore: (path: string, profileId: number) => invoke('backup:restore', path, profileId),
    delete: (path: string) => invoke('backup:delete', path),
  },

  // Wabbajack
  wabbajack: {
    parse: (wjPath: string, profileId: number) => invoke('wabbajack:parse', wjPath, profileId),
    browseModlists: () => invoke('wabbajack:browse-modlists'),
    export: (profileId: number, outputPath: string) => invoke('wabbajack:export', profileId, outputPath),
  },

  // IPC event subscription (for progress updates). Whitelisted channels only; the
  // wrapper is tracked internally so off() works with the ORIGINAL listener too
  // (previously it only worked if callers kept the wrapper returned by on()).
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!EVENT_CHANNELS.has(channel)) return undefined
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args)
    wrappers.set(listener, wrapped)
    ipcRenderer.on(channel, wrapped)
    return wrapped
  },
  off: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!EVENT_CHANNELS.has(channel)) return
    const wrapped = wrappers.get(listener) ?? listener
    ipcRenderer.removeListener(channel, wrapped as (event: IpcRendererEvent, ...args: unknown[]) => void)
    wrappers.delete(listener)
  },
})
