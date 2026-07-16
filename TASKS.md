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

## Sessione 2026-07-15/16 — consolidata
> Cambio di rotta architetturale: da companion-mode read-only intorno a MO2 a launcher SKSE-only che scrive davvero nel gioco. Dettagli tecnici completi in CHANGELOG.md (sezioni FOMOD-01/INTEGRITY-01/QUEUE-01/DEPLOY-GAME-01/CRASH-01/SKSE-ONLY-01/LOOT-MASTERLIST-01/CATALOG-REBUILD-01/LOADORDER-01/etc), MOD_CATALOG.md e SESSION_STATE.md (sezione 0).
| # | Task | Stato |
|---|------|-------|
| SKSE-01 | Avvio esclusivo SKSE (shortcut Desktop → bootstrapper interno); MO2 rimosso dal percorso di avvio di default (`mo2Bootstrapper` resta esportato ma inutilizzato); preflight semplificato a solo SKSE | ✅ |
| Deploy-Game-01 | Deploy `deployTarget: 'game'` scrive davvero nella `Data` del gioco reale; reversibile (backup `<file>.smm-vanilla.bak` pre-sovrascrittura, purge esatto da manifest, junction degradano a hardlink per-file quando la dir esiste già) | ✅ |
| LootOrder-01 | Motore LOOT-like in-house (no LOOT.exe, no MO2): `espParser.ts` legge i master reali da header binario TES4 (verificato 355/355), `lootSort.ts` topological sort con blocco su master mancante/ciclo, `lootMasterlist.ts`+`masterlistCache.ts` scaricano/cachano la masterlist community reale loot/skyrimse (3162 plugin, 47 gruppi, 429 regole, 872 dirty entries, solo su azione utente), `dirtyPluginCheck.ts`+`crc32.ts` rilevano plugin dirty via CRC32 (verificato vs test vector 0xCBF43926) | ✅ |
| Budget-01 | Gate pre-scrittura su budget plugin: blocca (`errorKind: 'plugin-limit'`) oltre 254 slot full o 4096 slot light, contati dai flag reali header TES4 | ✅ |
| Conflict-01 | Risoluzione conflitti via `resolution_weight` (migrazione v8) + planner deploy (categoria > peso > priorità/nome) + UI Conflitti (dry-run `deploy:preview` + bottone "Inverti precedenza" `deploy:prefer`); mai disattivazione mod | ✅ |
| Catalog-Wipe-01 | Bottone "Svuota catalogo" (`catalog:wipe`) + flag persistito `catalogSeedDisabled`; rimossa la `useEffect` colpevole dell'auto-seed silenzioso in `Catalog.tsx` (regressione ricorrente) | ✅ |
| Collections-01 | Import diretto "Collection Nexus" (`electron/nexus/collections.ts`): `parseCollectionInput` (slug/URL vecchio+nuovo formato), `fetchCollectionRevision` via GraphQL v2 ufficiale Nexus scritto a mano (il pacchetto npm pubblicato `@nexusmods/nexus-api` 1.1.5 non li espone ancora); sostituisce come via primaria l'import Vortex storico (backup eliminato su richiesta utente, v. nota Bak-01) | ✅ |
| Fomod-01 | Motore FOMOD ufficiale Vortex headless (`@nexusmods/fomod-installer-native`, N-API 8 .NET Native AOT, prebuilds, no rebuild) — `fomodApply.ts` (journal rename+rollback+marker idempotente), `collectionChoices.ts` (scelte curatore da `collection.json`), `engine.ts` (IPC `fomod:fetch-choices/scan/apply-all`); build: `asarUnpack` esteso + `npmRebuild:false` | ✅ |
| Enb-01 | Gestione preset ENB reale (non mock): scan mod estratte, apply copia file in root gioco + backup `.smm-enb-bak` + manifest `.smm-enb-manifest.json`, remove ripristina; avviso se manca `d3d11.dll` core (azione utente, non ridistribuibile) | ✅ |
| Crash-01 | Analisi automatica post-lancio (`crashLogAnalyzer.ts`, verificato su log reale 835 righe) + `crashEngine.ts` `armCrashWatch` (poll 30s per 3h, evento `crash:detected` → toast); analisi manuale anche in Strumenti | ✅ |
| Queue-Fix-01 | `sniffArchiveKind` (magic byte reali) sostituisce dispatch per estensione — root cause di 12/14 download falliti (RAR reali con estensione `.7z`); verdetto integrità `api-provenance` (solo senza hash atteso + URL da resolver API autenticato) ha chiuso i restanti 2/14; bottone "Riprova falliti" (`download:retry-failed`) | ✅ |
| Disk-Policy-01 | Archivio eliminato di default dopo install riuscita (`deleteArchiveAfterInstall`, override `keepArchives`); pulizia one-shot reale: 1737 archivi, 73,8 GB liberati (disco 94%→87%), + 23 GB liberati in una pulizia precedente della sessione | ✅ |
| Nexus-Scale-01 | Prova end-to-end su scala reale (Premium attivo): import Opoal Collection (slug `frkafa`, revisione 159, ~1739 mod) → coda download completata 1739/1739 → install → FOMOD 235 mod multi-scelta → conflitti risolti → deploy Data reale → preset ENB → crash-watch armato. Supera/chiude i rischi storici "Nexus non testato a scala", "e2e batch limitato a 4 mod" | ✅ |
| Pack-Review-01 | `build.disableAsarIntegrity:true` (Smart App Control blocca exe electron-builder ri-patchati non firmati) + `build.npmRebuild:false` (richiesto da Fomod-01) aggiunti alla config di build. **Invalidano potenzialmente** lo stato "GO_NO_GO packaging già verificato" dei documenti storici (Electron 29/33) → DA RIVERIFICARE con build NSIS fresca su questo stack, non dato per assodato | ⬜ |

## Backlog attivo (prossima sessione) → vedi TODO.md
| # | Task | Stato | Priorità |
|---|------|-------|----------|
| Act-01 | Attivazione Nexus reale (chiave + verifica HTTP e2e) | ✅ *(superato a scala, v. Sessione 2026-07-15/16: Premium attivo, chiave verificata più volte in-app, import+download+install completo Opoal Collection 1739/1739 mod reali)* | — |
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
| Boot-Deploy | StockGame-vs-game: i 271 mod sono in `StockGame/mods` (isolato), NON nel gioco; plugins.txt vuoto; base vanilla StockGame non assemblata | ✅ *(superato, v. Sessione 2026-07-15/16 Deploy-Game-01: deployTarget `game` scrive davvero nella `Data` del gioco reale, backup `.smm-vanilla.bak` + purge da manifest)* | — |
| Debt-01 (T3) | ~~Parsing reale plugins.txt da profilo MO2 (portable+instance)~~ *(superato, v. Sessione 2026-07-15/16 SKSE-01+LootOrder-01: MO2 fuori dal percorso di avvio di default, load order oggi da master reali header TES4, non più da plugins.txt MO2)* | ✅ | — |
| Debt-T5 | Versione Skyrim/SKSE reale → gameVersionSupported | ✅ | — |
| Debt-02 | backupManager → usare snapshot.ts (atomic+checksum+VACUUM) | ✅ | — |
| Debt-03 | Nexus search-by-name (catalogo locale, API non espone search) | ⬜ | Bassa |
| Eco-01 | Orchestrazione LOOT/xEdit/DynDOLOD/Nemesis/Pandora/Synthesis — quota LOOT ✅ chiusa in-house (v. Sessione 2026-07-15/16 LootOrder-01, nessuna dipendenza da LOOT.exe esterno); xEdit/DynDOLOD/Nemesis/Synthesis restano aperti | ⬜ | Bassa |
| Fomod-Research-Backlog | Backlog emerso da ricerca GitHub esplicita (round 2, focus FOMOD), mai implementato: preflight DLL SKSE (parse export PE `SKSEPlugin_Version`), validazione header ESP (1.71/form43/range FormID ESL), "Save Doctor" (.ess parser + diff plugin-list vs load order), rilevamento external-changes sul deploy verso il gioco reale, INI tuner da `settings.json` di BethINI Pie, grass cache autopilota (loop NGIO PrecacheGrass), auto-clean QAC via SSEEdit (tool non installato in questo ambiente) | ⬜ | Bassa/Media |

## Convenzione
Ogni task nuovo: ID `Area-NN`, riga in tabella, dettaglio in TODO.md se serve. A fine sessione marcare gli stati e aggiornare CHANGELOG.
