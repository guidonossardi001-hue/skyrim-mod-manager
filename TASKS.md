# TASKS

> Ledger dei task. Stato: `done` / `in_progress` / `todo`. I `todo` dettagliati sono in TODO.md.

## Legenda
✅ done · 🔄 in_progress · ⬜ todo

## Sessione corrente — consolidata
| # | Task | Stato |
|---|------|-------|
| Delta-01 | Core puro: canonicalJSON, version, manifest, diff | ✅ |
| Delta-02 | DB layer: pragmas, migration framework, integrity | ✅ |
| Delta-03 | Journal engine: changeset, gated commit, recovery | ✅ |
| Delta-04 | Backup hardening: VACUUM INTO, atomic, checksum | ✅ |
| Delta-05 | Wiring main/preload + single-instance + signer Python | ✅ |
| Delta-06 | Failure-sim test + docs v2 | ✅ |
| Delta-07 | DeltaService refactor + chiave reale + e2e (ingest→verify→stage→commit→recovery) | ✅ |
| Nexus-01 | Provider astratto + mock + http deferred + cache TTL/ETag | ✅ |
| Nexus-02 | Migrazione v3: nexus_cache + catalogo nexus_* | ✅ |
| Nexus-03 | `.env.example` + wiring IPC + factory | ✅ |
| Compat-01 | Analizzatore compatibilità (ESL/ESP/ESM, SKSE, version drift) | ✅ |
| Test-01 | Chaos test (failure injection) + stress (1000 mod) | ✅ |
| Launch-01 | Workflow avvio puro (10 stage) + test scenari failure | ✅ |
| Launch-02 | Parser VDF Steam + test | ✅ |
| Launch-03 | Sonda Steam (registry/process/fs) + buildLaunchEnv + UI preflight + mock | ✅ |
| Docs-01 | SESSION_STATE/ROADMAP/TASKS/TODO/RISK_MATRIX/GO_NO_GO/CHANGELOG/MOD_CATALOG | ✅ |
| Pack-01 | Build produzione + packaging `win-unpacked` + smoke runtime reale (electron.exe) | ✅ |
| UI-01 | Blocco 6: motori esposti nel renderer — pagine Aggiornamenti (delta) + Compatibilità (`compat:analyze`, T3+T5) | ✅ |
| Delta-08 | Baseline `installed_snapshot` da mod installate + `checkUpdates` reale; `checkAllUpdates` cablato al motore (no mock) | ✅ |

## Backlog attivo (prossima sessione) → vedi TODO.md
| # | Task | Stato | Priorità |
|---|------|-------|----------|
| Act-01 | Attivazione Nexus reale (chiave + verifica HTTP e2e) | ⬜ | Alta |
| Act-02 (T2) | Catalogo remoto reale firmato (file_id/file_hash sha256/version) + producer Node | ✅ | — |
| UI-02 | Badge "update disponibile" (Lista Mod per-riga + Sidebar) da drift delta | ✅ | — |
| Act-03 | Fetch HTTP reale del catalogo firmato (host allow-list, fail-closed) + verifica firma e2e | ✅ | — |
| Arc-01 | Download resumibile (.part+Range) + estrazione sicura streaming (7z progress, zip-slip, OOM cap, sha256 pre-estrazione) + UI progress | ✅ | — |
| Arc-02 | Client Nexus download_link (header apikey/Bearer, mappatura errori) + validazione/persistenza 7z.exe in Impostazioni | ✅ | — |
| Arc-03 | Chiave API Nexus persistita in SQLite (`app_secrets`, cifrata DPAPI) + client legge dal DB e inietta header | ✅ | — |
| Arc-04 | Protocol handler `nxm://` (setAsDefaultProtocolClient + single-instance argv → enqueue) + migrazione v5 key/expires | ✅ | — |
| Arc-05 | Reverse-eng. API installer Nolvus (reference) + pre-flight spazio disco pre-estrazione | ✅ | — |
| Arc-06 | Estrazione nativa .7z/.zip senza config (7-Zip bundlato, child-process, progress); .rar via 7z di sistema | ✅ | — |
| Arc-07 | .rar: 7-Zip di sistema primario (`detect7zPath`) + full 7z bundlato (asar-unpacked) fallback + notifica | ✅ | — |
| Lic-01 | Sezione UI "Licenze di terze parti" (scroll view) + licenza 7-Zip LGPL/unRAR bundlata (conformità) | ✅ | — |
| Vtx-01 | Importer Vortex (collection.json → modId/fileId, de-dup, catalog) + scan auto all'avvio + Pandora one-click gated | ✅ | — |
| UI-03 | Dashboard: counter mod uniche + gauge 300 GB + bottone "Sincronizza e Avvia" + toggle opt-in + console log live | ✅ | — |
| Cat-01 | Catalogo: +12 mod non-grafiche reali (ID Nexus verificati) + correzione 6 ID errati (103→115 voci, 35.4 GB) | ✅ | — |
| Cat-02 | Foundation Nolvus Ascension: +12 framework/SKSE-plugin base (ID reali da guida ufficiale, verificati) → 127 voci | ✅ | — |
| Bak-01 | Backup reale collezioni Vortex (`data/vortex-collections-backup.json`): 3 collection.json → 4.568 mod uniche, integrità sha256, 329,51 GB | ✅ | — |
| Stock-01 | StockGame builder: copia vanilla isolata (whitelist classifier, hardlink-first, async, companion-safe) + IPC + preload + 10 test | ✅ | — |
| Act-01b | Sblocco auth Nexus: toggle in-app `nexusEnabled` (no env var) + gating `main.ts` env||setting; chiave cifrata iniettata in provider+download_link | ✅ | — |
| E2E-01 | Download E2E reale (Nexus Premium): link CDN→download→md5 vs backup→7z test→estrazione in StockGame; harness `scripts/e2e_download.mjs` | ✅ | — |
| E2E-02 | E2E-BATCH a scala: formati misti .zip/.7z/.rar + file 1 GB, concorrenza 3, resume self-test (Range/.part); harness `scripts/e2e_batch.mjs` (4/4 OK) | ✅ | — |
| Stock-UI | Pannello UI StockGame in Dashboard (detect + hardlink/copia + barra progresso `stockgame:progress` + riepilogo); tipi `window.api.stockGame` | ✅ | — |
| Cabl-01 | Cablaggio produzione: orchestratore `massSync.ts` (primitive testate + md5 + isolamento StockGame) + IPC `sync:*` + bottone "Sincronizza e Avvia" con barra live + conferma | ✅ | — |
| Cabl-01-H | Hardening: retryPolicy condivisa (classific.+jitter+breaker), telemetria byte-precisa (throughput/ETA), progress per-fase, estrazione abortabile, cleanup .part; smoke reali 10@3 e 50@5 | ✅ | — |
| Precheck-01 | Pre-flight disco aggregato bloccante (pending×1.10×1.15 vs free) + IPC `sync:preflight` + card GO/NO-GO Dashboard; +5 test. Reale: 416.8 GB richiesti vs 276 liberi = NO-GO | ✅ | — |
| Pandora-Reg-01 | Detection Pandora read-only (`electron/tools/pandora.ts`) + IPC `tools:pandora:path` (persiste `pandoraPath`, no exec) + indicatore Dashboard; +6 test. Reale: v4.3.1-beta in C:\Pandora | ✅ | — |
| Exec-Boot-01 | Build Skyrim reale: 271/271 boot-mod scaricati (md5 ✓) in StockGame cache (22 GB) + Tier-0 (Address Library/Engine Fixes) deployati nel gioco; `scripts/exec_boot.mjs` | ✅ | — |
| Boot-Deploy | StockGame-vs-game: i 271 mod sono in `StockGame/mods` (isolato), NON nel gioco; plugins.txt vuoto; base vanilla StockGame non assemblata | ⬜ | Alta |
| Debt-01 (T3) | Parsing reale plugins.txt da profilo MO2 (portable+instance) | ✅ | — |
| Debt-T5 | Versione Skyrim/SKSE reale → gameVersionSupported | ✅ | — |
| Debt-02 | backupManager → usare snapshot.ts (atomic+checksum+VACUUM) | ✅ | — |
| Debt-03 | Nexus search-by-name (catalogo locale, API non espone search) | ⬜ | Bassa |
| Eco-01 | Orchestrazione LOOT/xEdit/DynDOLOD/Nemesis/Pandora/Synthesis | ⬜ | Bassa |

## Convenzione
Ogni task nuovo: ID `Area-NN`, riga in tabella, dettaglio in TODO.md se serve. A fine sessione marcare gli stati e aggiornare CHANGELOG.
