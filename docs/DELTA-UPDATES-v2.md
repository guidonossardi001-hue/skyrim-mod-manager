# Aggiornamenti Incrementali (Delta) — Architettura v2 (rimediata, Go-Live)

> Stato: **IMPLEMENTATO e TESTATO** (core di sicurezza + integrità). Supera [DELTA-UPDATES.md](DELTA-UPDATES.md) (v1, solo design).
> Stack: Electron (main) + better-sqlite3 + React/TS + Python (CI). **Nessun C++, nessuna patch binaria, nessun browser esterno.**
> Esito review: **No-Go (v1) → Go condizionato (v2)** — vedi §7.

La v1 è stata bloccata da una review avversariale che ha trovato 3 difetti CRITICI (RCE supply-chain, perdita dati irrecuperabile, integrità post-extract) + 6 ALTI. La v2 li chiude tutti con moduli ben fattorizzati e **testati con SQLite reale (`node:sqlite`), crypto reale (Ed25519) e fs reale** — 54 test verdi.

---

## 1. Mappatura delle 14 voci bloccanti → modulo + test

| # | Voce bloccante | Modulo | Test |
|---|----------------|--------|------|
| C1 | Manifest firmato Ed25519 + chiave pinnata | [manifest.ts](../electron/delta/manifest.ts), [engine.ts](../electron/delta/engine.ts) | `core.test.ts` (firma valida / tamper / chiave estranea) |
| C1 | `download_url` su host allow-listed | `manifest.ts` (`DEFAULT_ALLOWED_HOSTS`) | `core.test.ts` (host non consentito → reject) |
| M3 | Counter firmato monotòno (anti-replay/downgrade) | `manifest.ts` | `core.test.ts` (replay → reject) |
| C3 | Hash archivio verificato **pre-estrazione** | [snapshot.ts](../electron/backup/snapshot.ts) `verifyFileHash` | `snapshot.test.ts` (match/mismatch) |
| C2 | Snapshot **intero DB** via `VACUUM INTO` | `snapshot.ts` `snapshotDatabase` | `snapshot.test.ts` (tutte le tabelle + integrity) |
| C2 | `integrity_check` all'avvio | [sqlite.ts](../electron/db/sqlite.ts) | `migrations.test.ts`, `failureSim.test.ts` |
| A3 | PRAGMA `foreign_keys`/`WAL`/`busy_timeout` | `sqlite.ts` `applyPragmas` | `migrations.test.ts` (FK cascade) |
| A4 | Single-instance lock | [main.ts](../electron/main.ts) `requestSingleInstanceLock` | (runtime Electron) |
| A1 | Fix UNIQUE su recheck | [journal.ts](../electron/delta/journal.ts) `recordChangeset` | `journal.test.ts` (re-record dopo fail) |
| A2 | Single source of truth (bump solo nel commit finale) | `journal.ts` `finalizeApply` | `journal.test.ts`, `failureSim.test.ts` |
| A5 | Recovery all'avvio | `journal.ts` `recoverOnStartup` + `main.ts` | `journal.test.ts`, `failureSim.test.ts` |
| A6 | Comparatore versioni tollerante | [version.ts](../electron/delta/version.ts) | `core.test.ts` (mai throw) |
| M2 | Backup atomico (temp+fsync+rename) + checksum | `snapshot.ts` `atomicWriteFile`/`verifyChecksum` | `snapshot.test.ts` (truncation → refused) |
| M1 | Migration framework `user_version` | [migrations.ts](../electron/db/migrations.ts) | `migrations.test.ts` (ordine/idempotenza/rollback) |

---

## 2. Schema DB definitivo (migrazione v2, `PRAGMA user_version`)

Le 5 tabelle base restano (create con `IF NOT EXISTS`). La **migrazione 2** aggiunge — in una transazione, gated da `user_version` — 4 tabelle e 2 colonne, con FK `ON DELETE CASCADE`:

- `catalog_release(id, release_tag, **release_counter**, manifest_hash UNIQUE, source_url, published_at)`
- `catalog_release_mod(release_id→, nexus_id, name, priority_order, version, file_id, file_name, **file_hash**, download_url)` — lato "to"
- `installed_snapshot(profile_id→CASCADE, release_id, nexus_id, mod_id→SET NULL, version, file_id, file_name, file_hash, load_order)` — lato "from" e **unica fonte di verità**
- `delta_changeset(profile_id→CASCADE, to_release_id→CASCADE, nexus_id, change_type, …, status, download_id)` — **journal** resumibile
- `mods += nexus_file_id, file_hash` (ALTER guardato)

Indici unici: `(release_id, nexus_id)`, `(profile_id, nexus_id)`, `(profile_id, to_release_id, nexus_id)`.

**Migrazione:** ogni step in transazione propria; `user_version` bumpato atomicamente → crash tra migrazioni = sicuro (idempotente, ripartibile).

---

## 3. Trust boundary sul manifest (mitigazione RCE)

Il manifest è **input non fidato**. `verifyManifest` (in `delta:ingest`) richiede, in ordine, **fail-closed**:
1. **sha256** coerente col contenuto (integrità);
2. **firma Ed25519** valida dalla **chiave pinnata** `PINNED_PUBLIC_KEY_PEM` (autenticità → blocca repo compromesso/MITM);
3. **release_counter** strettamente monotòno (anti-replay/downgrade);
4. ogni **`download_url`** su host **allow-listed** (solo CDN Nexus).

Finché la chiave pubblica reale non è inserita, la verifica **fallisce closed** (nessun manifest accettato). Firma lato CI con il tool Python:
```bash
python scripts/sign_manifest.py keygen priv.pem pub.pem   # incolla pub.pem in PINNED_PUBLIC_KEY_PEM
python scripts/sign_manifest.py sign manifest.json priv.pem manifest.signed.json
```
La canonicalizzazione JSON (`sort_keys`, `separators=(",",":")`, `ensure_ascii=False`, **no float**) è byte-identica tra `sign_manifest.py` e [canonicalJson.ts](../electron/delta/canonicalJson.ts).

---

## 4. Flusso apply + rollback (gated, single-source-of-truth)

`delta:ingest` (verifica+store) → `delta:check` (diff→`delta_changeset`) → `delta:apply` (download solo added/changed; removed/reordered marcati subito) → ogni completamento avanza la riga e, **solo se tutte terminali-success**, `finalizeApply` esegue **una** transazione che: deriva `mods.version`/`file_hash` dalla release, fa upsert di `installed_snapshot`, applica reorder/removal, e pinna il profilo. **A2:** `mods.version` non viene mai bumpata a metà — solo nel commit gated.

**Rollback a 3 livelli** (tutti testati):
- **Atomicità** `withTransaction` (BEGIN/COMMIT/ROLLBACK) → nessuna scrittura parziale (`failureSim` power-loss).
- **Commit gated** → se una riga è `failed`, lo snapshot **non** avanza, stato resta pre-delta (`failureSim` interrupted update).
- **Snapshot intero DB** `VACUUM INTO` pre-delta → ripristino per copia file su DB corrotto (`failureSim` corrupt DB).

**Recovery (A5):** all'avvio `recoverOnStartup` resetta righe/download in volo a `pending`; `installed_snapshot` mai avanzato fuori dal commit gated → solo *resume* o *fail-safe*, mai mezzo-commit.

---

## 5. Evidenze di test (No-Go → Go)

`npm test` → **54 test, 8 file, tutti verdi**. SQLite reale (`node:sqlite`), Ed25519 reale, fs reale.

| Suite | Cosa prova |
|-------|-----------|
| `electron/delta/core.test.ts` (18) | canonicalJSON; comparatore mai-throw; **firma/tamper/replay/host**; diff |
| `electron/db/migrations.test.ts` (6) | migrazione 0→2; idempotenza; `integrity_check`; **FK cascade**; rollback su throw |
| `electron/delta/journal.test.ts` (4) | **A1** recheck idempotente; **A2** commit gated + invariante; **A5** recovery |
| `electron/backup/snapshot.test.ts` (5) | **VACUUM INTO** whole-DB; write atomico; **truncation refused**; hash pre-extract |
| `electron/delta/failureSim.test.ts` (5) | crash+recovery; gate su download fallito; power-loss atomicità; **DB corrotto→detect→restore**; manifest corrotto→reject |
| `src/lib/*` (16) | dipendenze, preflight, modlist, version |

---

## 6. Piani operativi

**Recovery:** avvio → `integrity_check`; se KO → ripristino dall'ultimo `pre-delta.db` (`VACUUM INTO`, checksum-validato) per `copyFileSync`. `recoverOnStartup` reimposta gli aggiornamenti in volo.

**Rollback delta:** prima di ogni apply → snapshot intero DB. Annullamento = copia snapshot sul DB + riavvio. A livello DB ogni mutazione è in transazione gated.

---

## 7. Checklist finale Go / No-Go

| Voce | Stato |
|------|-------|
| Manifest firmato + chiave pinnata + verifica | ✅ implementato/testato (**chiave reale da inserire** prima del rilascio — vedi §8) |
| download_url allow-list | ✅ |
| Anti-replay counter | ✅ |
| Hash pre-estrazione | ✅ `verifyFileHash` |
| VACUUM INTO whole-DB snapshot | ✅ |
| integrity_check all'avvio | ✅ |
| PRAGMA FK/WAL/busy_timeout | ✅ + delete FK-safe |
| Single-instance lock | ✅ |
| Fix UNIQUE recheck | ✅ |
| Single source of truth | ✅ |
| Recovery all'avvio | ✅ |
| Comparatore tollerante | ✅ |
| Backup atomico + checksum | ✅ |
| Migration framework | ✅ |
| Failure-injection test verdi | ✅ 54/54 |
| Renderer build OK + tsc 0 errori | ✅ |

**Esito: GO**, condizionato all'unico residuo operativo in §8.

---

## 8. Rischi residui (espliciti)

1. ~~**🔑 Chiave pubblica reale da inserire**~~ → **CHIUSO** (v2.1). Generata una coppia Ed25519 reale; chiave pubblica incorporata in [pinnedKey.ts](../electron/delta/pinnedKey.ts) (override via `NOLVUS_MANIFEST_PUBKEY`); manifest di esempio firmato e committato ([examples/catalog.signed.json](../electron/delta/examples/catalog.signed.json)); flusso **ingest→verify→stage→commit→recovery** verificato e2e con chiave+manifest reali ([e2e.test.ts](../electron/delta/e2e.test.ts)). La privata vive solo in `secrets/` (gitignored) → CI secret store. Vedi [GO-LIVE.md](GO-LIVE.md).
2. **Manifest producer-side** deve pubblicare `file_id`+`file_hash`+`version` per mod; finché il catalogo GitHub non li espone, la detection `changed` ripiega sul confronto versione tollerante (hash assente).
3. **Apply end-to-end con rete reale** (download Nexus multi-GB + estrazione 7z) non è eseguibile nell'ambiente di sviluppo headless: la macchina a stati e i gate di integrità sono testati; il trasporto riusa la pipeline esistente già verificata.
4. **File deployati** non sono snapshottati byte-a-byte: il rollback ri-deriva da `installed_snapshot` + ri-download content-addressed (per design, non patch binarie).
5. **Wiring auto-finalize**: `onDeltaDownloadComplete`/`onDeltaDownloadFailed` ([engine.ts](../electron/delta/engine.ts)) sono il punto d'aggancio agli eventi del download manager; in v2 è esposto anche `delta:finalize` come fallback esplicito lato renderer.

---

## 9. Setup chiave di firma (runbook CI)

```bash
pip install cryptography
python scripts/sign_manifest.py keygen release_priv.pem release_pub.pem
# 1) conserva release_priv.pem nel secret store CI (mai nel repo)
# 2) incolla release_pub.pem in PINNED_PUBLIC_KEY_PEM (electron/delta/engine.ts)
# 3) in pipeline di pubblicazione catalogo:
python scripts/sign_manifest.py sign catalog.json release_priv.pem catalog.signed.json
# 4) pubblica catalog.signed.json su raw.githubusercontent (l'app lo verifica con la chiave pinnata)
```
