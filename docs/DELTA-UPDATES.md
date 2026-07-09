# Aggiornamenti Incrementali (Delta) — Blueprint Architetturale

> Stato: **DESIGN** (non ancora implementato). Stack target: Electron (main) + better-sqlite3 + React/TS (renderer, Zustand).
> Vincoli rispettati: nessuna patch binaria, nessun browser esterno, nessun MEGA. "Delta" = ri-download dei soli archivi **cambiati** + changeset a livello DB.

---

## 0. Diagnosi — perché oggi manca la base dati

Il sistema attuale è **detection-only e basato su stringa di versione**:

- `checkAllUpdates` (in `src/store/appStore.ts`) cicla le mod con `nexus_id`, chiama `nexus.getMod`, legge **solo** `data.version` e calcola `hasUpdate = latestVersion !== mod.version` (disuguaglianza di stringa, non ordinamento semantico).
- Il risultato vive **solo in memoria** in `modUpdates: Record<modId, {latestVersion, hasUpdate}>` (Zustand) → **perso ad ogni reload**, non persistito su DB.
- **Manca il lato "from"**: la mod installata non registra *quale file Nexus* è deployato (nessun `file_id`/hash). Senza il lato "da cui partire" non esiste delta: si hanno solo due stringhe di versione.
- **Manca il lato "to" concreto**: nessun `file_id`/`file_name`/`file_hash`/`download_url` del nuovo file → nessun target scaricabile.
- **Manca un'azione di apply**: nulla scarica+installa il nuovo file, aggiorna `version` e fa rollback in caso di errore.

**Conclusione:** servono (1) snapshot versionati del catalogo remoto, (2) uno snapshot dello stato installato per profilo, (3) un changeset persistito come journal, (4) il riuso della pipeline esistente (download → install → backup) per applicare il delta in modo transazionale.

---

## 1. Data Model di Versioning

Approccio **snapshot-centrico**: il delta è la **differenza insiemistica** tra lo snapshot installato del profilo e l'ultima release del catalogo. Tutto è **additivo** — le 5 tabelle esistenti (`profiles`, `mods`, `downloads`, `settings`, `modlist_catalog`) non vengono ridefinite.

### 1.1 Schema SQL (idempotente, dentro `initDatabase()`)

```sql
-- ── (1) Release immutabili del catalogo remoto. Una riga per snapshot pubblicato.
CREATE TABLE IF NOT EXISTS catalog_release (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  release_tag   TEXT NOT NULL,            -- es. "2026.06.22" o semver dal manifest
  manifest_hash TEXT NOT NULL UNIQUE,     -- sha256 del manifest canonicalizzato → re-ingest idempotente
  source_url    TEXT,                     -- URL raw.githubusercontent.com di origine
  published_at  TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ── (2) Righe per-release/per-mod: il lato "ULTIMO DISPONIBILE" del diff.
--     Rispecchia modlist_catalog + l'IDENTITÀ DI FILE che oggi manca.
CREATE TABLE IF NOT EXISTS catalog_release_mod (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id     INTEGER NOT NULL,
  nexus_id       INTEGER NOT NULL,        -- identità mod stabile tra release
  name           TEXT NOT NULL,
  category       TEXT NOT NULL,
  subcategory    TEXT,
  priority_order INTEGER DEFAULT 999,     -- guida la detection 'reordered'
  required       INTEGER DEFAULT 0,
  description    TEXT,
  author         TEXT,
  tags           TEXT DEFAULT '[]',
  size_mb        INTEGER DEFAULT 0,
  has_it_translation INTEGER DEFAULT 0,
  notes          TEXT,
  conflicts_with TEXT DEFAULT '[]',
  requires       TEXT DEFAULT '[]',
  -- identità di file (il cuore del delta, assente nel sistema detection-only):
  version        TEXT,                    -- versione semantica (ordinamento)
  file_id        INTEGER,                 -- file_id Nexus dell'archivio target
  file_name      TEXT,                    -- nome archivio (guida findCachedArchive)
  file_hash      TEXT,                    -- hash contenuto archivio (detection 'changed')
  download_url   TEXT,                    -- link diretto pre-risolto (opzionale)
  FOREIGN KEY (release_id) REFERENCES catalog_release(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_release_nexus ON catalog_release_mod(release_id, nexus_id);
CREATE INDEX IF NOT EXISTS idx_crm_release ON catalog_release_mod(release_id);

-- ── (3) Il lato "ATTUALMENTE INSTALLATO" del diff, una riga per mod-catalogo per profilo.
--     Scritto atomicamente alla FINE di un apply riuscito (o al primo bootstrap).
CREATE TABLE IF NOT EXISTS installed_snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  INTEGER NOT NULL,
  release_id  INTEGER,                    -- la release a cui il profilo è "pinnato"
  nexus_id    INTEGER NOT NULL,
  mod_id      INTEGER,                    -- FK in mods (la riga deployata)
  version     TEXT,
  file_id     INTEGER,
  file_name   TEXT,
  file_hash   TEXT,                       -- hash dell'archivio effettivamente deployato
  load_order  INTEGER DEFAULT 0,
  applied_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES profiles(id),
  FOREIGN KEY (mod_id)     REFERENCES mods(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_profile_nexus ON installed_snapshot(profile_id, nexus_id);

-- ── (4) Changeset persistito = JOURNAL resumibile. Una riga per mod che differisce.
--     Sostituisce la mappa modUpdates in-memory: sopravvive al reload, guida l'apply,
--     ed è ripartibile (status per riga).
CREATE TABLE IF NOT EXISTS delta_changeset (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      INTEGER NOT NULL,
  from_release_id INTEGER,                -- release pinnata dello snapshot (null al primo giro)
  to_release_id   INTEGER NOT NULL,       -- ultima release target
  nexus_id        INTEGER NOT NULL,
  change_type     TEXT NOT NULL,          -- 'added'|'removed'|'changed'|'reordered'
  from_version    TEXT,  to_version    TEXT,
  from_file_hash  TEXT,  to_file_hash  TEXT,
  to_file_id      INTEGER, to_file_name TEXT, to_download_url TEXT,
  from_load_order INTEGER, to_load_order INTEGER,
  status          TEXT DEFAULT 'pending', -- 'pending'|'downloading'|'installing'|'applied'|'failed'|'skipped'
  download_id     INTEGER,                -- link alla riga downloads creata in apply
  error           TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id)    REFERENCES profiles(id),
  FOREIGN KEY (to_release_id) REFERENCES catalog_release(id),
  FOREIGN KEY (download_id)   REFERENCES downloads(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delta_open ON delta_changeset(profile_id, to_release_id, nexus_id);
```

### 1.2 Colonne additive su `mods` (lato "from", ALTER guardato)

SQLite non supporta `ALTER ... ADD COLUMN IF NOT EXISTS` e better-sqlite3 lancia su colonna duplicata → guardia via `PRAGMA table_info`:

```ts
// dopo il db.exec(...) esistente in initDatabase()
const modCols = (db.prepare("PRAGMA table_info(mods)").all() as {name:string}[]).map(c => c.name)
if (!modCols.includes('nexus_file_id')) db.exec("ALTER TABLE mods ADD COLUMN nexus_file_id INTEGER")
if (!modCols.includes('file_hash'))     db.exec("ALTER TABLE mods ADD COLUMN file_hash TEXT")
```

### 1.3 Invariante di correttezza (la chiave di volta)

> **Dopo un apply riuscito: `installed_snapshot(profile)` ≡ `catalog_release_mod(to_release)`.**
> Un `delta:check` successivo che restituisce **zero** modifiche è la *prova* che il delta è stato applicato integralmente. È anche il test di rollback: dopo un rollback, lo snapshot deve coincidere con la release `from`.

---

## 2. Refactoring di `checkAllUpdates`

Da **N chiamate Nexus + confronto stringa** a **diff DB persistito**. Il lavoro pesante (ingest manifest + diff) si sposta nel main process (better-sqlite3 sincrono); il renderer fa una lettura.

### 2.1 Nuovi handler IPC (main process)

```text
delta:ingest-release(payload, sourceUrl) -> releaseId
  manifestHash = sha256(canonicalJSON(payload))
  if exists catalog_release WHERE manifest_hash = manifestHash: return its id   // idempotente
  tx:
    INSERT catalog_release(release_tag, manifest_hash, source_url, published_at)
    for mod in payload: INSERT catalog_release_mod(release_id, ...campi..., version, file_id, file_name, file_hash, download_url)
    -- aggiorna anche la vista navigabile usata da catalog:list (riusa il path catalog:seed)
  return releaseId

delta:check(profileId) -> { toReleaseId, counts:{added,removed,changed,reordered} }
  toRel  = SELECT id FROM catalog_release ORDER BY id DESC LIMIT 1
  target = SELECT * FROM catalog_release_mod WHERE release_id = toRel
  snap   = SELECT * FROM installed_snapshot WHERE profile_id = ?
  tx:                                            -- UN'unica transazione: diff atomico
    DELETE FROM delta_changeset WHERE profile_id=? AND to_release_id=toRel AND status='pending'
    for t in target:
      s = snap[t.nexus_id]
      if   !s                                   -> push 'added'
      elif s.file_hash != t.file_hash
        || semverGt(t.version, s.version)        -> push 'changed'   (hash+semver, NON stringa nuda)
      elif s.load_order != t.priority_order      -> push 'reordered'
    for s in snap:
      if !target[s.nexus_id]                     -> push 'removed'
    INSERT ogni differenza in delta_changeset(... status='pending', from_release_id=s.release_id)
  return counts

delta:list-changeset(profileId) -> rows   // SELECT * FROM delta_changeset (lettura pura)
```

### 2.2 Store refactor (renderer, lettura pura — niente loop Nexus)

```ts
checkAllUpdates: async () => {
  const profileId = get().activeProfileId
  await window.api.delta.ingestLatestIfAvailable?.()      // fetch manifest → catalog_release (best-effort)
  const { counts } = await window.api.delta.check(profileId)   // ricalcola + persiste
  const rows = await window.api.delta.listChangeset(profileId)

  // Ricostruisce modUpdates dallo stato PERSISTITO (non più chiamate per-mod)
  const byNexus = Object.fromEntries(get().mods.map(m => [m.nexus_id, m]))
  const modUpdates: Record<number, ModUpdate> = {}
  for (const c of rows) {
    const m = byNexus[c.nexus_id]; if (!m) continue
    modUpdates[m.id] = {
      latestVersion: c.to_version ?? m.version,
      hasUpdate: c.change_type === 'changed' || c.change_type === 'added',
      changeType: c.change_type,        // nuovo → badge UI più ricco
      toFileId: c.to_file_id,
    }
  }
  set({ modUpdates, deltaCounts: counts })
  return { checked: rows.length, updates: counts.added + counts.changed }
}
```

> La forma di `modUpdates[mod.id]` resta un **superset** di oggi (`{latestVersion, hasUpdate}`) → `ModDetailPanel`/`Tools` continuano a funzionare senza modifiche. `checkForUpdates(modId)` diventa una `SELECT` da `delta_changeset` join `mods` per `nexus_id`.

---

## 3. Flusso di Applicazione del Delta (con rollback)

Nuovo IPC `delta:apply(profileId, toReleaseId)`. Principio cardine: **le scritture DB sono transazionali e veloci; download/estrazione (lenti, async) stanno FUORI dalle transazioni**; solo i loro risultati terminali vengono ripiegati nel commit finale.

```text
1. PRECONDIZIONE. rows = SELECT * FROM delta_changeset
      WHERE profile_id=? AND to_release_id=? AND status IN ('pending','failed')
   se vuoto → return {applied:0}.  (se stale, ri-esegui delta:check prima)

2. PUNTO DI ROLLBACK. se settings.autoBackup:
      backup:create(profileId, label='pre-delta_rel<toReleaseId>')   // snapshot JSON di mods
   conserva il path del backup per un eventuale ripristino.

3. PIANIFICA DOWNLOAD (solo 'added' + 'changed'):
   per ogni riga:
     a. GUARDIA CONTENT-ADDRESS: se 'changed' e to_file_hash == from_file_hash
        → status='skipped' (etichetta versione cambiata, archivio identico) — NIENTE rete.
     b. assicura una riga mods:
          'added'   → INSERT mods (traduci CatalogMod→Mod: priority_order→priority,
                      size_mb→file_size, has_it_translation→translation_it,
                      conflicts_with→conflicts) via il path mods:add (whitelisted), is_installed=0
          'changed' → riusa la mods.id esistente (lookup per nexus_id nel profilo)
     c. CACHE: downloadManager.findCachedArchive(to_file_name); se hit e hash == to_file_hash
        → short-circuit a install. Altrimenti downloads:add({mod_id, nexus_id,
          file_id:to_file_id, name:to_file_name, url:to_download_url})
          e UPDATE delta_changeset SET download_id=?, status='downloading'.

4. ENQUEUE. downloads:add accoda già (downloadQueue.enqueue) → coda/pump/retry/circuit-breaker
   esistenti girano invariati. Ogni download completato chiama onInstall → installManager.runInstall
   (estrae in modsRoot()/<name>, flippa mods.is_installed=1, install_path). NESSUN nuovo codice di rete.

5. HOOK COMPLETAMENTO PER-MOD (su evento install:complete {id, modId}):
     trova la riga changeset per download_id → status='applied'
     UPDATE mods SET version=to_version, nexus_file_id=to_file_id, file_hash=to_file_hash WHERE id=modId
   (per-mod, NON batch: il fallimento di un archivio non avanza falsamente gli altri)

6. RIMOZIONI ('removed'): nessun download. Nel commit finale (step 8): rm modsRoot()/<folder>,
   poi DELETE mods (o is_enabled=0 per soft-removal) e DELETE installed_snapshot riga.

7. RIORDINI ('reordered'): nessun download/estrazione → solo UPDATE mods SET priority=to_load_order
   (semantica identica a mods:reorder) nel commit finale.

8. COMMIT ATOMICO (db.transaction) — GATED: parte SOLO se ogni riga non-'skipped' è 'applied'.
     - applica rimozioni (6) e riordini (7)
     - per ogni added/changed applicato: UPSERT installed_snapshot(profile_id, nexus_id, mod_id,
       version, file_id, file_name, file_hash, load_order)
     - per i removed: DELETE installed_snapshot
     - pinna il profilo: installed_snapshot.release_id = toReleaseId
     - marca il changeset 'applied'
   better-sqlite3 è sincrono e all-or-nothing → snapshot e mods si muovono insieme.

9. POST-CONDIZIONE. installed_snapshot(profile) ≡ catalog_release_mod(toReleaseId).
   Un delta:check fresco restituisce zero → prova di apply integrale.
```

### 3.1 Strategia di rollback / integrità (3 livelli)

**(A) Atomicità DB — `db.transaction()`.** Ogni gruppo di mutazioni DB (il diff in `delta:check`, il commit finale in step 8) è in un'unica transazione sincrona: se uno statement lancia, l'intera transazione fa **ROLLBACK**, nessuna riga parziale persiste. È lo stesso pattern già usato da `catalog:seed`, `mods:reorder`, `backup:restore`.

**(B) Commit finale GATED.** Download ed estrazione sono async e **fuori** dalle transazioni. Il commit dello step 8 parte **solo** se tutte le righe non-`skipped` sono `applied`. Se anche una è `failed`, lo snapshot **non** viene avanzato → il profilo resta consistente con lo stato **pre-delta** a livello DB. L'utente può ri-eseguire `delta:apply` (idempotente: le righe `applied` si saltano, la cache content-addressed evita ri-download) o fare rollback. Questa è anche la **resumibilità** (journal): re-run riprende le righe `pending`/`failed`.

**(C) Backup JSON come punto di rollback dello stato-catalogo.** Il `backup:create` pre-delta (step 2) snapshotta la tabella `mods` del profilo. In caso di abort dopo un apply parziale, `backup:restore(path, profileId)` esegue `DELETE FROM mods WHERE profile_id=?` + re-insert, riportando `version`/`nexus_file_id`/`file_hash` ai valori pre-delta. Dopo il restore si riallinea `installed_snapshot` al pin `from_release_id` nella stessa transazione.

**File on-disk:** il backup **non** snapshotta i file estratti in `modsRoot()`, ma il delta non richiede mai un rollback byte-level: ogni mod `changed` è un ri-download completo dell'archivio (content-addressed via `file_hash`, riusabile dalla cache), e `installManager` ri-estrae nella stessa cartella. Un download fallito lascia `downloads.status='failed'` e (step 5) la `version` della mod **non** avanza → quella mod resta sulla versione precedente mentre le altre procedono (degrado graduale).

---

## 4. Vincoli, migrazione e rischi

### 4.1 Conformità ai vincoli
- ✅ **Niente patch binarie**: il delta è ri-download dei soli archivi cambiati + changeset DB.
- ✅ **Niente browser esterno / MEGA**: si riusa `download_link.json` Nexus (Premium) o URL diretto, già nel `downloadManager`.
- ✅ **Integrabile nello stack**: 4 tabelle additive + 2 colonne `mods` guardate; riuso integrale di `downloads`/`downloadManager`/`installManager`/`backupManager`.

### 4.2 Migrazione (zero-downtime, additiva, in `initDatabase()`)
1. `CREATE TABLE IF NOT EXISTS` per le 4 tabelle (no-op su install esistenti).
2. `ALTER TABLE mods` guardato via `PRAGMA table_info` per `nexus_file_id`, `file_hash` (nullable → righe legacy valide).
3. **Whitelist**: aggiungere `nexus_file_id`, `file_hash` a `MOD_COLUMNS` (main.ts) così `mods:add/update` possono scriverle.
4. **⚠️ Backup parity (obbligatorio)**: aggiungere `nexus_file_id`, `file_hash` **sia** alla `INSERT` **sia** all'array `BOUND` di `backupManager.ts`, altrimenti i restore perdono silenziosamente l'identità di file. (I backup vecchi hanno il campo `undefined` → il fallback `mod[col] ?? null` esistente li gestisce.)
5. **Bootstrap one-time** (`delta:bootstrap`, gated su settings `delta_bootstrapped`): ingerisce il catalogo corrente come `catalog_release #1` e popola `installed_snapshot` dalle `mods` con `is_installed=1` (hash `NULL` dove ignoto → appaiono come `changed` al primo delta, self-healing dopo un apply).
6. **Ordine di deploy**: prima schema+whitelist+backup+seed (puramente additivi, il renderer vecchio ignora i campi nuovi), poi i nuovi IPC + wiring renderer.

### 4.3 Rischi / incompatibilità
| Rischio | Mitigazione |
|---|---|
| Il **manifest remoto deve pubblicare** `file_id`+`file_hash`+`version` per mod; oggi `getMod` legge solo `version`. | Cambio **producer-side** (schema del catalogo su GitHub). Finché manca, la detection `changed` degrada a confronto semantico di versione (no hash). |
| `backupManager` BOUND/INSERT da tenere in **lockstep** con le nuove colonne `mods`. | Footgun noto → checklist in §4.2.4 + test che verifica round-trip backup/restore delle nuove colonne. |
| File deployati **non** snapshottati byte-a-byte. | Rollback ri-deriva da `installed_snapshot` + ri-download content-addressed; cartelle corrotte rilevate via mismatch `file_hash`. |
| Mod **senza `nexus_id`** (import manuale/Wabbajack) restano fuori dal diff. | Accettabile: il delta riguarda il catalogo gestito; le mod manuali non sono parte della release. |
| Confine **async download / sync DB**: serve una piccola macchina a stati che gati il commit finale sugli stati terminali. | Il journal `delta_changeset.status` È la macchina a stati; il commit gated (§3.1.B) ne è la guardia. |

---

## 5. Confronto approcci (perché questo design)

| Approccio | Schema | Pro | Contro | Esito |
|---|---|---|---|---|
| **A. Minimal** (catalog_release row + colonne versione + mod_update_state) | minimo | migrazione minima, riuso pipeline | `catalog_version` globale grezzo, niente invariante dimostrabile | scartato come nucleo, ne prendo la *disciplina di migrazione* |
| **B. Snapshot-centric** (installed_snapshot + catalog_release_mod + delta_changeset) | medio | **invariante dimostrabile**, journal resumibile, content-addressing | richiede file identity nel manifest, lockstep backup | **✅ ADOTTATO** |
| **C. Changeset+Journal** (update_plan/update_op) | medio-alto | resumibilità esplicita | più tabelle/macchina a stati ridondante con B | assorbito in B (`delta_changeset.status` = journal) |

> Nota di processo: la fase di **verifica avversariale** del workflow di design è caduta per limite di sessione; i controlli su rollback/transazioni/migrazione sono stati incorporati manualmente in §3.1 e §4.3 a partire dai *cons* auto-dichiarati delle proposte e dalla conoscenza del codice. Una revisione avversariale dedicata resta consigliata prima dell'implementazione.
