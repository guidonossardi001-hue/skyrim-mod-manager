# SESSION_STATE

> Snapshot vivo dello stato del progetto. Aggiornare a fine di ogni sessione di lavoro.
> Ultimo aggiornamento: **2026-07-08** · Stato: **GO-LIVE READY** (app) · build Skyrim in esecuzione (BOOT_GATE_01).
> Ultimo intervento: **AUTODETECT-01 — rilevamento automatico percorsi (zero config).** Nuovo `electron/tools/autoDetect.ts`: cartella Skyrim via registro Steam (`detectSteamEnv`) + `scanForExes` (DFS profondità≤3, denylist `SKIP_DIRS`, single-pass multi-tool) su root standard (`standardToolRoots`) per MO2 (+`mods` derivata)/LOOT/SSEEdit/DynDOLOD/xLODGen, 7-Zip (`detect7zPath`), Pandora (`findPandoraExe`); **fallback silenzioso** (tool assenti → campo vuoto, mai bloccante). IPC `settings:auto-detect` + `applyDetectedPaths({fillEmptyOnly})` (persiste solo i trovati nel DB cifrato, non sovrascrive valori utente) + **auto-run all'avvio** (`setImmediate`). Bottone **"Rileva Automaticamente"** in cima a "Percorsi Gioco e Strumenti" (`Settings.tsx`). **+7 test → 264 verdi**, `tsc`/`vite build` OK, bottone verificato nel preview. **Detection reale** (~2,4s): gamePath (registro) + 7-Zip + Pandora rilevati; MO2/LOOT/SSEEdit/DynDOLOD/xLODGen non installati → lasciati vuoti.
> Precedente: **EXECUTE-BOOT-01 + deploy Tier-0 (build Skyrim reale).** Auth Nexus live PASS (Premium, Daily 20000). Scaricati **271/271 boot-mod** (0 fail, md5 ✓) → cache `data/boot_cache/downloads` (7,13 GB) + estratti in `data/StockGame/mods` (271 cartelle, 22,06 GB); 467 plugin per estensione. Tier-0 (Address Library 32444 + Engine Fixes Part 2 17230) = MANUAL_REQUIRED → l'utente li ha deployati **manualmente nel gioco Steam (A)**: `Data\SKSE\Plugins\{EngineFixes.dll,EngineFixes.toml,versionlib-1-6-1170-0.bin(795129B)}` + root `d3dx9_42.dll`. **Stato osservato**: file boot-critici (SKSE+AddressLib+EngineFixes) PRESENTI nel gioco A → boot-critical READY; MA i 271 mod sono in `StockGame/mods` (cache isolata), **NON** nel gioco A; `plugins.txt` vuoto (0 attivi) → SkyUI/MCM/CrashLogger non attivi. `data/StockGame` = staging/PORTABLE_GAME isolato, **base vanilla NON assemblata** (no exe). Gioco avviabile = solo **A** (`skse64_loader.exe`). Divergenza: mod in StockGame, boot-file in GAME_ROOT.
> Precedente: **PANDORA-REGISTER-01 — detection Pandora (read-only).** `electron/tools/pandora.ts` (`findPandoraExe`/`detectPandora`, FsProbe iniettato) + IPC `tools:pandora:path` (persiste `pandoraPath`, **mai esegue**) + `window.api.tools.pandoraPath` + indicatore "Pandora ✓ Rilevato" in Dashboard. +6 test → **257 verdi**, build OK. Reale: rilevato `C:\Pandora\…v4.3.1-beta-133232\Pandora Behaviour Engine+.exe` (preferita la build versionata vs Preview).
> Precedente: **PRECHECK-01 — pre-flight disco aggregato bloccante.** `massSync.ts`: `pendingBytes`/`computeDiskPreflight`/`diskPreflight` (required = pending × 1.10 estrazione × 1.15 sicurezza, configurabili) + enforcement fail-closed **prima** di ogni download; dep `freeSpace`→`getFreeSpace`. IPC `sync:preflight` + card GO/NO-GO in Dashboard (richiesto/disponibile/margine). +5 test → **251 verdi**, `tsc`/build OK. **Verifica reale**: 4.568 mod → richiesti **416,8 GB** vs **276 GB liberi C:** = **NO-GO** (il blocco funziona; disco saturo da Steam 236 GB + Vortex 329 GB). Limite: 1.10 è per-difetto. Prossimo: run reale progressivo 100→300→500 mod.
> Precedente: **Cabl-01-Hardening — mass-sync reso affidabile per 4.568 mod/329 GB.** `retryPolicy.ts` condiviso (classificazione 429/5xx/ECONNRESET/TLS/CF + jitter + circuit-breaker), riusato da `downloadManager` e `massSync` (no policy duplicata). Telemetria **byte-precisa** (throughput MB/s + ETA, barra byte-monotòna). `active[]` con **fase** (download/verifica/estrazione). `extractArchive` **abortabile** (`proc.kill`) + cleanup `destDir` parziale. **Smoke reali**: 10@3 e 50@5, 5/5 check verdi (retry+resume reale, no `.part` residuo, no leak, isolamento). **246 test** verdi (+17), `tsc`/`vite build` OK. Limite: throughput/ETA non esercitati su mod minuscoli (coperti da unit test).
> Precedente: **Cabl-01 — flusso di massa reale cablato nella Dashboard.** Orchestratore `electron/sync/massSync.ts` (resolve→download resumibile→**md5 vs backup**→estrai, concorrente, idempotente, cancellabile) con **isolamento StockGame fail-closed** (`assertIsolated`, mai la cartella Steam). IPC `sync:start|cancel|status` + `window.api.sync`. Bottone "Sincronizza e Avvia" → conferma scale-aware (~329 GB, solo StockGame) + **barra di progresso live** (`sync:progress`). **229 test** verdi (+9), `tsc`/`vite build` OK, Dashboard verificata nel preview. Il run reale parte SOLO al click utente nell'app desktop con Nexus attivo.
> Precedente: **E2E-BATCH a scala superato + pannello UI StockGame.** Batch reale 4/4: `.7z`/`.zip`/`.rar` + file **1,01 GB**, concorrenza 3, **resume self-test** (caduta→HTTP Range→integro), tutti md5 ✓ + `7z t` ✓ (harness `scripts/e2e_batch.mjs`). Pipeline blindata su formati misti/file pesante/concorrenza/resume. Pannello `StockGamePanel.tsx` nella Dashboard (detect + hardlink/copia + barra progresso `stockgame:progress`), verificato nel preview. Prossimo: cablare il flusso reale (download di massa dal backup) nel bottone "Sincronizza e Avvia" (TODO Cabl-01).
> Precedente: **Pipeline download E2E REALE superata.** Primo download reale con Nexus Premium: `4k Farmhouse Fences SE` (38912/153295, 50 MB) → link CDN `cf-files.nexusmods.com` → download → **md5 ✓** vs backup → `7z t` ✓ → **8 file estratti** (96,3 MB) in `data/StockGame/mods/`. Installer provato autonomo sul percorso reale (singola mod). Harness `scripts/e2e_download.mjs`. Prossimo: validazione a scala (batch formati misti) prima di cancellare i 329 GB di Vortex.
> Precedente: **Backup collezioni Vortex + StockGame isolato + sblocco auth Nexus.** (1) `data/vortex-collections-backup.json` — export READ-ONLY dei 3 collection.json reali → **4.568 mod uniche** (modId+fileId+md5+fileSize), **329,51 GB**, integrità sha256 ok: mette in sicurezza la fonte di verità prima di pulire Steam. (2) `electron/install/stockGame.ts` — copia **vanilla isolata** companion-safe (whitelist classifier, hardlink-first + copy async, salta tutte le mod), IPC `stockgame:detect|create` + `window.api.stockGame`. (3) Toggle in-app `nexusEnabled` (Impostazioni) per attivare il provider HTTP senza env var; chiave cifrata in `app_secrets` iniettata in provider+download_link. Steam reale: `c:\librearia steam`, Skyrim **236,23 GB** (moddato). **220 test** verdi, `tsc`/`vite build` OK.
> Precedente: **Foundation Nolvus Ascension nel catalogo** — +12 framework/SKSE-plugin base (ID Nexus reali verificati). Catalogo 115→127 voci.
> Precedente: **Catalogo esteso** — +12 mod non-grafiche reali (LotD/Bruma/Forgotten City/Wyrmstooth/…) + correzione 6 ID errati.
> Precedente: **Dashboard "Sincronizza e Avvia"** (counter mod uniche + gauge 300 GB + bottone + toggle opt-in + console log live).
> Precedente: **Importer Vortex** — `electron/vortex/scan.ts` (collection.json → modId/fileId, de-dup, catalog) + scan auto all'avvio + Pandora gated.
> Precedente: **Sezione "Licenze di terze parti"** (`src/data/licenses.ts`, scroll view, conformità LGPL/unRAR).
> Precedente: **.rar nativo** — `resolveRar7z()` (sistema primario + full 7z bundlato fallback + notifica).
> Precedente: **Estrazione nativa .7z/.zip senza config** (`7zip-bin` bundlato, child-process, progress `-bsp1`).
> Precedente: **Reverse-eng. API Nolvus + pre-flight spazio disco** (`docs/NOLVUS-API-REFERENCE.md` + `install/diskSpace.ts`).
> Precedente: **Protocol handler `nxm://`** (`electron/nexus/nxm.ts` + migrazione v5 key/expires + single-instance argv→enqueue).
> Precedente: **Chiave API Nexus nel DB cifrata** (migrazione v4 `app_secrets`, DPAPI).
> Precedente: **Client Nexus download_link + validazione 7-Zip** (`nexus/downloadLink.ts`, `install/sevenZip.ts` + IPC `tools:validate-7z`).
> Precedente: **Archivi reali — download streaming + estrazione sicura** (`install/{downloadStream,extract}.ts`).
> Precedente: **Act-03 fetch HTTP reale + verifica firma** (`fetchCatalog.ts` SSRF-safe → IPC `delta:ingest-url`; campo `catalogUrl`).
> Precedente: **T2 catalogo remoto reale firmato + badge drift** (`catalog.remote.signed.json` via `scripts/build_remote_catalog.mjs`; badge "update disponibile" Lista Mod + Sidebar).
> Precedente: **Delta reali**: `snapshot.ts` semina `installed_snapshot`; `DeltaService.checkUpdates`; `store.checkAllUpdates` cablato al motore.
> Precedente: **Blocco 6 — motori esposti nella UI**: pagina **Aggiornamenti** (flusso delta via `window.api.delta.*`) e pagina **Compatibilità** (IPC `compat:analyze`, T3+T5).
> Precedente: T3 (plugins.txt reale da profilo MO2 — portable + instance-mode) + T5 (versione Skyrim/SKSE → gameVersionSupported), review avversariale applicata.

## 1. Identità progetto
- **App:** Skyrim AE Mod Manager (desktop, ecosistema Nolvus).
- **Stack:** Electron 29 + React 18 + TypeScript + Vite 5 · DB **better-sqlite3** · firma manifest **Python (CI)** · niente C++.
- **Working dir:** `C:\ai\skyrim-mod-manager` · DB runtime: `userData/skyrim-manager.db`.

## 2. Stato build & test (verificato)
- **Test:** `npm test` → **264 test, 35 file, tutti verdi** (vitest; incl. auto-detect percorsi, pre-flight disco, retryPolicy, mass-sync hardening, StockGame builder, importer Vortex, estrazione nativa reale .7z/.zip + codec Rar, conformità licenze, HTTP server reale, Ed25519, secret cifrato, nxm, spazio disco).
- **Schema DB:** `PRAGMA user_version = 5` (1 baseline, 2 delta-versioning, 3 nexus-cache+catalogo, 4 app_secrets, **5 nxm key/expires su downloads**).
- **TypeScript:** `tsc --noEmit` 0 errori su renderer **e** electron (CJS via grafo `main.ts`).
- **Renderer build:** `vite build` OK. **App si avvia** nel preview (Dashboard, console pulita).
- **Packaging:** `electron-builder --win --dir` → `release/win-unpacked/Skyrim AE Mod Manager.exe` (168 MB), `app.asar` 53 MB, **`better_sqlite3.node` UNPACKED ✓**. Wrapper NSIS bloccato da limite-ambiente symlink Windows (vedi RISK_MATRIX R11).
- **Smoke runtime reale (`electron.exe`):** PASS — better-sqlite3 carica, migrazioni→**v5** (+ `app_secrets`, `downloads.nxm_*`), integrity ok, **manifest firmato verificato con chiave reale**, re-ingest idempotente. (`scripts/smoke.ts`)

## 3. Sottosistemi e file chiave
| Area | File | Stato |
|---|---|---|
| Delta update (core) | `electron/delta/{canonicalJson,version,manifest,diff,journal,service,engine,hooks,pinnedKey,snapshot,fetchCatalog}.ts` | ✅ testato |
| Catalogo via HTTP (Act-03) | `fetchCatalog.ts` (host allow-list, HTTPS, no-redirect, size cap) → IPC `delta:ingest-url`; campo `catalogUrl` in Settings | ✅ e2e (server reale) |
| Archivi reali (download+estrazione) | `electron/install/{downloadStream,extract,sevenZip,diskSpace}.ts` (resume `.part`/Range; **7za bundlato** .7z/.zip no-config + child-process + progress; .rar via 7z sistema; zip-slip; sha256; spazio disco) → `installManager` | ✅ testato (e2e) |
| StockGame isolato | `electron/install/stockGame.ts` (whitelist vanilla classifier; hardlink-first + copy async; companion-safe READ-ONLY su sorgente; verifica file richiesti) → IPC `stockgame:detect|create` + `stockgame:progress` | ✅ testato (10) |
| Backup collezioni Vortex | `data/vortex-collections-backup.json` (4.568 mod uniche, modId/fileId/md5, sha256) via `scripts/_export_collections_backup.mjs` | ✅ verificato |
| Nexus download_link + 7-Zip | `electron/nexus/downloadLink.ts` (apikey/Bearer) + `electron/install/sevenZip.ts` + IPC `tools:validate-7z` + sezione Impostazioni | ✅ testato |
| Delta — versioning persistente | `installed_snapshot` baseline da mod installate (`snapshot.ts`) + `checkUpdates` (snapshot vs manifest) → `store.checkAllUpdates` | ✅ testato |
| Manifest firmato esempio | `electron/delta/examples/catalog.signed.json` (+ chiave pub `docs/keys/release_pub.pem`) | ✅ e2e |
| DB framework | `electron/db/{sqlite,migrations,openTestDb}.ts` | ✅ |
| Backup hardening | `electron/backup/{snapshot,manager}.ts` (VACUUM INTO, atomic, checksum, restore-refuse-corrupt) — **cablato** in `backupManager.ts` | ✅ testato |
| Nexus provider (deferred) | `electron/nexus/{types,cache,mockProvider,httpProvider,index}.ts` | ✅ mock attivo |
| Steam + launch | `electron/steam/{vdf,detect,version,mo2}.ts` · `electron/launch/preflight.ts` · `src/lib/launchWorkflow.ts` · `src/components/ui/LaunchPreflight.tsx` | ✅ |
| Compat analyzer + engine | `src/lib/compatibility.ts` · `electron/launch/compat.ts` (IPC `compat:analyze`) · `src/lib/plugins.ts` | ✅ |
| UI motori (Blocco 6) | `src/components/pages/{Updates,Compatibility}.tsx` (delta + compat via `window.api`) | ✅ verificato preview |
| Altre lib pure | `src/lib/{dependencies,preflight,modlist}.ts` | ✅ |
| Signer | `scripts/sign_manifest.py` (CI, canonico) + `scripts/build_remote_catalog.mjs` (producer Node, parità locale) | ✅ |
| Catalogo remoto reale | `electron/delta/examples/catalog.remote.signed.json` (T2: `file_id`/`file_hash`/`version`, verificato pinned key) | ✅ testato |
| Config segreti | `.env.example` · `secrets/` (**gitignored**) | ✅ |

## 4. Decisioni architetturali consolidate
- **Single source of truth** = `installed_snapshot`; `mods.version` derivata solo nel commit finale gated.
- **Trust boundary** sul manifest: Ed25519 pinnato + allowlist host + counter monotòno (anti-replay) → **fail-closed**.
- **Rollback** = snapshot intero DB (`VACUUM INTO`) + transazioni atomiche + commit gated.
- **Engine-agnostic DB layer**: prod=better-sqlite3, test=node:sqlite (stesso SQLite, no clash ABI Electron).
- **Companion mode**: l'app non modifica mai Steam/gioco; blocca l'avvio se mancano critici.

## 5. Stato attivazioni "deferred"
- **Firma manifest:** chiave pubblica reale incorporata (`pinnedKey.ts`); privata solo in `secrets/` → CI secret store. **Attivo.**
- **Nexus API:** `NEXUS_ENABLED=false` → mock provider. Inserire chiave + `=true` per attivare l'HTTP provider (nessuna modifica codice). La chiave è **inserita manualmente** dall'utente in Impostazioni e persistita **cifrata** nel DB (`app_secrets`, DPAPI); il client la legge e la inietta come header `apikey`/`Bearer` nelle richieste reali (download_link). Niente OAuth.

## 6. Come riprendere
1. `npm install` → `npm run setup` (electron-rebuild better-sqlite3).
2. `npm test` (deve restare verde).
3. Dev browser: `.\start.ps1 browser` · Dev Electron: `.\start.ps1 electron`.
4. Vedi ROADMAP.md per i prossimi passi, TODO.md per il debito tecnico.

## 7. Documenti di stato (mantenere allineati)
SESSION_STATE · ROADMAP · TASKS · TODO · RISK_MATRIX · GO_NO_GO · CHANGELOG · MOD_CATALOG.
Documentazione tecnica: `docs/{DELTA-UPDATES,DELTA-UPDATES-v2,NEXUS-INTEGRATION,LAUNCH-WORKFLOW,GO-LIVE}.md`.
