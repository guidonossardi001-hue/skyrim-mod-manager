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

      // Backfill canonical installed_version source from the legacy display field.
      db.exec('UPDATE mods SET nexus_file_id = nexus_file_id') // no-op touch; columns are nullable
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
