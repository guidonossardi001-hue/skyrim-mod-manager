// Real-runtime smoke test — run UNDER electron.exe (not ELECTRON_RUN_AS_NODE) so
// better-sqlite3's Electron-ABI native build loads. Exercises the actual main-process
// data path: open DB → pragmas → base schema → latest migrations → integrity → and a
// signed-manifest delta INGEST/VERIFY with the real pinned key. Exits 0 on PASS.
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { applyPragmas, integrityCheck, getUserVersion, type SqliteDb } from '../electron/db/sqlite'
import { runMigrations, LATEST_SCHEMA_VERSION } from '../electron/db/migrations'
import { DeltaService } from '../electron/delta/service'
import { pinnedPublicKey } from '../electron/delta/pinnedKey'

let failed = 0
function check(cond: unknown, msg: string) {
  if (cond) console.log(`  [ok] ${msg}`)
  else {
    console.error(`  [FAIL] ${msg}`)
    failed++
  }
}

try {
  const db = new Database(':memory:') as unknown as SqliteDb
  applyPragmas(db)
  db.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
      game_path TEXT, mo2_path TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE mods (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, nexus_id INTEGER,
      name TEXT NOT NULL, version TEXT, category TEXT, is_enabled INTEGER DEFAULT 1, is_installed INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0, load_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, mod_id INTEGER, profile_id INTEGER NOT NULL,
      name TEXT NOT NULL, status TEXT DEFAULT 'pending');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE modlist_catalog (id INTEGER PRIMARY KEY AUTOINCREMENT, nexus_id INTEGER UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, required INTEGER DEFAULT 0);
  `)

  const mig = runMigrations(db)
  check(
    getUserVersion(db) === LATEST_SCHEMA_VERSION,
    `migrazioni → user_version ${LATEST_SCHEMA_VERSION} (applicate: ${mig.applied.join(',')})`,
  )
  check(integrityCheck(db), 'PRAGMA integrity_check = ok')
  for (const t of [
    'catalog_release',
    'catalog_release_mod',
    'installed_snapshot',
    'delta_changeset',
    'nexus_cache',
    'app_secrets',
  ]) {
    check(
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t),
      `tabella ${t} presente`,
    )
  }

  // Real signed-manifest verification + ingest under the Electron runtime.
  const signed = JSON.parse(
    readFileSync(join(process.cwd(), 'electron', 'delta', 'examples', 'catalog.signed.json'), 'utf8'),
  )
  db.prepare('INSERT INTO profiles (id, name) VALUES (1, ?)').run('Smoke')
  const svc = new DeltaService(db, { publicKeyPem: pinnedPublicKey() })
  const ing = svc.ingest(signed)
  check(ing.success === true, `ingest+verify manifest firmato (chiave reale) → release #${ing.releaseId}`)
  const relMods = db.prepare('SELECT COUNT(*) c FROM catalog_release_mod').get() as { c: number }
  check(relMods.c === 3, `catalog_release_mod popolato (${relMods.c} mod)`)
  const reingest = svc.ingest(signed)
  check(reingest.reused === true, 'ri-ingest idempotente (reused)')

  console.log(failed === 0 ? '\nSMOKE PASS ✓' : `\nSMOKE FAIL (${failed})`)
  process.exit(failed === 0 ? 0 : 1)
} catch (e) {
  console.error('SMOKE CRASH:', (e as Error).message)
  process.exit(2)
}
