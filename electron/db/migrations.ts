import {
  type SqliteDb,
  withTransaction,
  getUserVersion,
  setUserVersion,
  columnExists,
  tableExists,
} from './sqlite'

// Ordered, versioned migration framework keyed on PRAGMA user_version (fixes M1).
// Each migration runs in its OWN transaction and bumps user_version atomically, so
// a crash between migrations is safe: on restart, already-applied migrations are
// skipped and the first un-applied one re-runs from a clean state.
//
// The base five tables are still created by initDatabase() with IF NOT EXISTS for
// backward compatibility; migration 1 is therefore a no-op marker that simply
// claims user_version 1 for installs predating this framework. Migration 2 adds
// the delta-versioning tables and the two file-identity columns on `mods`.

export interface Migration {
  version: number
  name: string
  up: (db: SqliteDb) => void
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up: () => {
      /* base schema already ensured by initDatabase(); marker only */
    },
  },
  {
    version: 2,
    name: 'delta-versioning',
    up: (db) => {
      db.exec(`
        -- Immutable remote catalog snapshots (one row per published release).
        CREATE TABLE IF NOT EXISTS catalog_release (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          release_tag   TEXT NOT NULL,
          release_counter INTEGER NOT NULL DEFAULT 0,  -- signed monotonic anti-replay value
          manifest_hash TEXT NOT NULL UNIQUE,
          source_url    TEXT,
          published_at  TEXT,
          created_at    TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- Per-release / per-mod entries: the "latest available" side of the diff,
        -- carrying the file identity the detection-only system lacked.
        CREATE TABLE IF NOT EXISTS catalog_release_mod (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          release_id     INTEGER NOT NULL,
          nexus_id       INTEGER NOT NULL,
          name           TEXT NOT NULL,
          category       TEXT,
          priority_order INTEGER DEFAULT 999,
          version        TEXT,
          file_id        INTEGER,
          file_name      TEXT,
          file_hash      TEXT,
          download_url   TEXT,
          FOREIGN KEY (release_id) REFERENCES catalog_release(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_release_nexus ON catalog_release_mod(release_id, nexus_id);

        -- The "currently installed" side of the diff, one row per installed mod
        -- per profile. Source of truth for the from-side identity.
        CREATE TABLE IF NOT EXISTS installed_snapshot (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id  INTEGER NOT NULL,
          release_id  INTEGER,
          nexus_id    INTEGER NOT NULL,
          mod_id      INTEGER,
          version     TEXT,
          file_id     INTEGER,
          file_name   TEXT,
          file_hash   TEXT,
          load_order  INTEGER DEFAULT 0,
          applied_at  TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
          FOREIGN KEY (mod_id)     REFERENCES mods(id)     ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_profile_nexus ON installed_snapshot(profile_id, nexus_id);

        -- Persisted changeset = resumable journal. status per row drives apply
        -- and recovery; UNIQUE is per (profile,to_release,nexus_id) — recheck must
        -- clear ALL non-applied rows first (see journal.recordChangeset).
        CREATE TABLE IF NOT EXISTS delta_changeset (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id      INTEGER NOT NULL,
          from_release_id INTEGER,
          to_release_id   INTEGER NOT NULL,
          nexus_id        INTEGER NOT NULL,
          change_type     TEXT NOT NULL,
          from_version    TEXT,  to_version    TEXT,
          from_file_hash  TEXT,  to_file_hash  TEXT,
          to_file_id      INTEGER, to_file_name TEXT, to_download_url TEXT,
          from_load_order INTEGER, to_load_order INTEGER,
          status          TEXT NOT NULL DEFAULT 'pending',
          download_id     INTEGER,
          error           TEXT,
          created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (profile_id)    REFERENCES profiles(id) ON DELETE CASCADE,
          FOREIGN KEY (to_release_id) REFERENCES catalog_release(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_delta_open ON delta_changeset(profile_id, to_release_id, nexus_id);
      `)

      // Additive file-identity columns on the existing mods table (from-side).
      // Guarded because SQLite lacks ADD COLUMN IF NOT EXISTS.
      if (!columnExists(db, 'mods', 'nexus_file_id'))
        db.exec('ALTER TABLE mods ADD COLUMN nexus_file_id INTEGER')
      if (!columnExists(db, 'mods', 'file_hash')) db.exec('ALTER TABLE mods ADD COLUMN file_hash TEXT')
    },
  },
  {
    version: 3,
    name: 'nexus-cache-and-catalog',
    up: (db) => {
      // HTTP response cache for the (deferred) Nexus provider: TTL + ETag, offline-safe.
      db.exec(`
        CREATE TABLE IF NOT EXISTS nexus_cache (
          key        TEXT PRIMARY KEY,
          etag       TEXT,
          body       TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,   -- epoch ms
          ttl_ms     INTEGER NOT NULL
        );
      `)
      // Persistent local catalog enrichment (Nexus metadata + provenance/integrity).
      // Guarded: the catalog table is created by initDatabase() before migrations,
      // but a migration must not assume tables outside its own framework exist.
      if (tableExists(db, 'modlist_catalog')) {
        const catalogCols: [string, string][] = [
          ['source', 'TEXT'],
          ['collection_id', 'INTEGER'],
          ['sha256', 'TEXT'],
          ['last_verified', 'TEXT'],
          ['nexus_mod_id', 'INTEGER'],
          ['nexus_file_id', 'INTEGER'],
          ['nexus_version', 'TEXT'],
          ['nexus_last_check', 'INTEGER'],
          ['nexus_download_url', 'TEXT'],
          ['nexus_dependencies', 'TEXT'],
          ['nexus_endorsement_state', 'TEXT'],
          ['nexus_category', 'TEXT'],
        ]
        for (const [col, type] of catalogCols) {
          if (!columnExists(db, 'modlist_catalog', col))
            db.exec(`ALTER TABLE modlist_catalog ADD COLUMN ${col} ${type}`)
        }
      }
    },
  },
  {
    version: 4,
    name: 'app-secrets',
    up: (db) => {
      // Persistent secret store (the manually-entered Nexus API key). The `value` is
      // ALWAYS encrypted at rest (OS keychain / Windows DPAPI via safeStorage) before
      // it reaches this table — never plaintext — so the DB file cannot leak the key.
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_secrets (
          name       TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `)
    },
  },
  {
    version: 5,
    name: 'nxm-download-auth',
    up: (db) => {
      // nxm:// non-premium downloads carry a short-lived key/expires pair that must
      // be forwarded to the Nexus download_link endpoint. Persist them per download.
      // Guarded: downloads is created by initDatabase() before migrations.
      if (tableExists(db, 'downloads')) {
        if (!columnExists(db, 'downloads', 'nxm_key'))
          db.exec('ALTER TABLE downloads ADD COLUMN nxm_key TEXT')
        if (!columnExists(db, 'downloads', 'nxm_expires'))
          db.exec('ALTER TABLE downloads ADD COLUMN nxm_expires INTEGER')
      }
    },
  },
  {
    version: 6,
    name: 'hot-path-indices',
    up: (db) => {
      // The hot queries (mods:list, downloads:list, processPending, delta download
      // callbacks) previously full-scanned their tables: at Nolvus scale (~4.500 mod
      // per profilo) every list/refresh paid O(N) instead of an index seek.
      // Guarded like migration 5: the base tables come from initDatabase().
      // Ogni indice è doppiamente guardato (tabella + colonna): i DB di test/legacy
      // possono avere schemi parziali e una migrazione non deve mai dare per
      // scontato uno schema che non ha creato lei stessa.
      const index = (table: string, column: string, name: string) => {
        if (tableExists(db, table) && columnExists(db, table, column)) {
          db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`)
        }
      }
      index('mods', 'profile_id', 'idx_mods_profile')
      index('mods', 'nexus_id', 'idx_mods_nexus')
      index('downloads', 'profile_id', 'idx_downloads_profile')
      index('downloads', 'status', 'idx_downloads_status')
      index('downloads', 'mod_id', 'idx_downloads_mod')
      index('delta_changeset', 'download_id', 'idx_delta_download')
    },
  },
  {
    version: 7,
    name: 'install-recipes',
    up: (db) => {
      // Deterministic FOMOD-replacement: per-mod file-mapping "recipes" that decide
      // exactly which archive paths land in the game (see electron/install/recipe.ts).
      // Populated from the SIGNED catalog on ingest (CatalogService.replaceAll), so
      // the recipe — which controls file placement — inherits the Ed25519 trust
      // boundary. Keyed per ARCHIVE version (file_id) because folder layouts reshuffle
      // between releases; a NULL file_id is the nexus-wide default recipe.
      db.exec(`
        CREATE TABLE IF NOT EXISTS mod_install_recipe (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          nexus_id       INTEGER NOT NULL,
          file_id        INTEGER,           -- NULL ⇒ default recipe for the mod
          file_hash      TEXT,              -- binds a file-specific recipe to its exact archive
          schema_version INTEGER NOT NULL DEFAULT 1,
          strategy       TEXT NOT NULL DEFAULT 'root',
          instructions   TEXT NOT NULL,     -- InstallInstructions JSON
          created_at     TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_nexus_file ON mod_install_recipe(nexus_id, file_id);
        CREATE INDEX IF NOT EXISTS idx_recipe_nexus ON mod_install_recipe(nexus_id);
      `)
    },
  },
  {
    version: 8,
    name: 'deploy-conflict-metadata',
    up: (db) => {
      // Auto-resolution metadata for the deploy planner (computeDeployPlan): the
      // asset class that drives the category rule (a 'patch' overrides a 'texture')
      // and the weight that breaks same-class ties (4K=4000 beats 2K=2000).
      //
      // Two homes, both additive & guarded (SQLite has no ADD COLUMN IF NOT EXISTS):
      //   • mods            — the INSTALLED record the deployer reads at deploy time.
      //   • modlist_catalog — the signed-catalog source the values are ingested from.
      if (!columnExists(db, 'mods', 'deploy_category'))
        db.exec('ALTER TABLE mods ADD COLUMN deploy_category TEXT')
      if (!columnExists(db, 'mods', 'resolution_weight'))
        db.exec('ALTER TABLE mods ADD COLUMN resolution_weight INTEGER')

      if (tableExists(db, 'modlist_catalog')) {
        if (!columnExists(db, 'modlist_catalog', 'deploy_category'))
          db.exec('ALTER TABLE modlist_catalog ADD COLUMN deploy_category TEXT')
        if (!columnExists(db, 'modlist_catalog', 'resolution_weight'))
          db.exec('ALTER TABLE modlist_catalog ADD COLUMN resolution_weight INTEGER')
      }
    },
  },
  {
    version: 9,
    name: 'download-integrity-hash',
    up: (db) => {
      // Trusted expected hash for the MANDATORY download integrity gate. Set at download
      // creation from a trusted source (delta manifest sha256, or a backup/catalog md5);
      // NULL means "no local hash" → the gate falls back to Nexus md5_search or fails closed.
      // hash_algo distinguishes md5 (Nexus/backup native) from sha256 (delta manifest).
      // Guarded: downloads is created by initDatabase() before migrations.
      if (tableExists(db, 'downloads')) {
        if (!columnExists(db, 'downloads', 'file_hash'))
          db.exec('ALTER TABLE downloads ADD COLUMN file_hash TEXT')
        if (!columnExists(db, 'downloads', 'hash_algo'))
          db.exec('ALTER TABLE downloads ADD COLUMN hash_algo TEXT')
      }
    },
  },
  {
    version: 10,
    name: 'mod-translations',
    up: (db) => {
      // Best-effort translation mapping for the mass-installer: base mod nexus_id → its ITA
      // translation mod/file on Nexus. Populated from the Vortex backup (collections often ship the
      // ITA patch as a separate mod) and/or Nexus discovery. One mapping per (base mod, language);
      // the resolver reads it fail-soft (no row → install the base mod, no error).
      db.exec(`
        CREATE TABLE IF NOT EXISTS mod_translation (
          base_nexus_id        INTEGER NOT NULL,
          language             TEXT NOT NULL DEFAULT 'it',
          translation_nexus_id INTEGER NOT NULL,
          translation_file_id  INTEGER,
          translation_md5      TEXT,
          source               TEXT,               -- 'backup' | 'curated' | 'nexus'
          created_at           TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (base_nexus_id, language)
        );
        CREATE INDEX IF NOT EXISTS idx_mod_translation_base ON mod_translation(base_nexus_id);
      `)
    },
  },
  {
    version: 11,
    name: 'catalog-multi-file',
    up: (db) => {
      // Le Collection Nexus hanno mod con PIÙ file required (main + patch ESL/USSEP, o main +
      // addon — 156 mod / 200 file sulla collection reale): il vincolo inline `nexus_id UNIQUE`
      // permetteva UNA sola riga per mod e l'import ne scartava il resto. Si ricostruisce la
      // tabella senza quel vincolo (SQLite non sa rimuovere un constraint inline) e l'unicità
      // passa a due indici:
      //   • (nexus_id, nexus_file_id) — più file per mod, mai lo stesso file due volte;
      //   • nexus_id parziale su nexus_file_id IS NULL — le righe senza file (seed curato)
      //     restano una-per-mod come prima, così i re-import non le duplicano.
      if (tableExists(db, 'modlist_catalog')) {
        const ddl = (
          db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='modlist_catalog'").get() as
            | { sql: string }
            | undefined
        )?.sql
        if (ddl && /nexus_id\s+INTEGER\s+UNIQUE/i.test(ddl)) {
          // Ricostruzione DINAMICA: le colonne reali includono quelle aggiunte dalle migrazioni
          // 3 e 8, quindi lo schema nuovo si deriva da PRAGMA table_info, non da una lista fissa.
          const cols = db.prepare('PRAGMA table_info(modlist_catalog)').all() as {
            name: string
            type: string
            notnull: number
            dflt_value: string | null
            pk: number
          }[]
          const colDefs = cols
            .map((c) => {
              if (c.pk) return `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`
              let def = `${c.name} ${c.type || 'TEXT'}`
              if (c.notnull) def += ' NOT NULL'
              if (c.dflt_value != null) def += ` DEFAULT ${c.dflt_value}`
              return def
            })
            .join(',\n            ')
          const colNames = cols.map((c) => c.name).join(', ')
          db.exec(`
            CREATE TABLE modlist_catalog_new (
            ${colDefs}
            );
            INSERT INTO modlist_catalog_new (${colNames}) SELECT ${colNames} FROM modlist_catalog;
            DROP TABLE modlist_catalog;
            ALTER TABLE modlist_catalog_new RENAME TO modlist_catalog;
          `)
        }
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_nexus_file
            ON modlist_catalog(nexus_id, nexus_file_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_nexus_nofile
            ON modlist_catalog(nexus_id) WHERE nexus_file_id IS NULL;
        `)
      }
    },
  },
]

export interface MigrationResult {
  from: number
  to: number
  applied: number[]
}

export function runMigrations(db: SqliteDb): MigrationResult {
  const from = getUserVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  const applied: number[] = []
  for (const m of pending) {
    withTransaction(db, () => {
      m.up(db)
      setUserVersion(db, m.version)
    })
    applied.push(m.version)
  }
  return { from, to: getUserVersion(db), applied }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
