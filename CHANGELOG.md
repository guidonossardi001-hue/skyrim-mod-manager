# CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/) · SemVer.

## [Unreleased]

## [1.0.2] — 2026-07-17

### Packaging
- **Installer NSIS ricostruito** con dentro tutti i fix di questa sessione (GUARD-01, TOOLS-01, T11): `release/Skyrim-AE-Fantasy-Launcher-Setup-1.0.2.exe` (132 MB) + `latest.yml` + `.blockmap` coerenti. App impacchettata avviata e verificata viva (4 processi, log boot pulito, provider Nexus attivo).

### Added — T11: backup profilo compressi gzip (2026-07-17)
- `electron/backup/manager.ts`: i nuovi backup profilo sono scritti gzip-compressi (`.json.gz`, tipicamente 80%+ più piccoli — rilevante quando se ne accumulano decine su un disco quasi pieno). Retrocompatibile al 100%: `listBackups` e `restoreProfileBackup` riconoscono i vecchi backup `.json` in chiaro tramite sniffing dei magic byte gzip (non dall'estensione) — nessuna migrazione, i backup esistenti restano ripristinabili. `deleteBackup` ripulisce entrambe le varianti + sidecar. Snapshot DB (`.db`, raro, pre-delta) lasciato non compresso: resta un artefatto di recovery manuale. Incrementale scartato: il contenuto è un dump di righe DB, non file — diff incrementale sarebbe complessità senza beneficio su questo volume di dati. +7 test, suite 864.
- Pulizia backlog: T6 (search catalogo locale), T8 (endpoint `nexus:search` legacy) e T13 (`secrets/release_pub.pem` ridondante) erano già risolti in sessioni precedenti non documentate — verificati e chiusi in TODO.md.

### Added — TOOLS-01: provisioning strumenti dalle release GitHub ufficiali (2026-07-17)
- **`electron/tools/provision.ts`**: LOOT (loot/loot), SSEEdit (TES5Edit/TES5Edit) e xLODGen (sheson/xLODGen) scaricati dalle release GitHub ufficiali quando mancanti — owner/repo costanti, asset accettato solo dal dominio release del repo (anti-tamper), estrazione atomica, exe individuato per candidati. Le release xEdit recenti shippano `xTESEdit*.exe` (verificato sull'archivio 4.1.5f reale): creato alias `SSEEdit64.exe` (l'exe adatta il gioco al nome). IPC `tools:provision-missing` + bottone "Scarica strumenti (GitHub)" in Impostazioni. DynDOLOD escluso (non su GitHub — dyndolod.info). **Eseguito sulla macchina reale: LOOT 0.29.1 + SSEEdit 4.1.5f + xLODGen v132 installati in `<userData>/tools` e cablati in config** (Pandora già presente, rilevato). 15 test nuovi, suite 858.

## [1.0.1] — 2026-07-16

### Packaging
- **Installer NSIS ricostruito sullo stack corrente** (Electron 43.1.0, electron-builder 26, Vite 8, Node 24, `disableAsarIntegrity:true` per Smart App Control, `npmRebuild:false` per il modulo nativo FOMOD): `release/Skyrim-AE-Fantasy-Launcher-Setup-1.0.1.exe` (132 MB) + `latest.yml` + `.blockmap` coerenti (PIVOT-13 chiuso). App impacchettata avviata e verificata viva (4 processi, provider Nexus attivo, log boot pulito).

### Added — GUARD-01: protezione aggiornamenti Steam + verifica deploy + Save Doctor (2026-07-16)
- **Protezione aggiornamenti Steam** (`electron/steam/updateGuard.ts`): rende read-only `appmanifest_489830.acf` (metodo community standard) così Steam non può aggiornare Skyrim e rompere SKSE/plugin nativi; reversibile in un click dalla card in Impostazioni. Stato reale dall'acf (AutoUpdateBehavior, buildid via `vdf.ts`). Drift detection: la versione runtime vista a ogni lancio riuscito è registrata (`lastKnownGameVersion`) e confrontata in preflight → warning "Skyrim aggiornato da Steam (from → to)".
- **Verifica external-changes del deploy** (`electron/deploy/verifyDeploy.ts`, T17): confronto manifest ↔ disco (file mancanti, sostituiti esternamente con nlink=1, junction scollegate). Bottone "Verifica" nel DeployPanel + check automatico in preflight ("Deploy alterato esternamente" → riesegui Deploy). Helper condiviso `deploy/resolveTarget.ts` per la dir Data (engine + preflight, zero drift di logica).
- **Save Doctor** (`electron/saves/`, T16): parser fail-soft dei salvataggi `.ess` SE/AE (decoder LZ4 block puro con prefix-decode — niente dipendenze native; zlib/uncompressed supportati; doppio layout con/senza stringa versione gioco) + diff plugin del save vs load order attivo (plugins.txt di sistema ∪ file in Data, copre vanilla+CC). Warning preflight "Ultimo salvataggio a rischio" con i nomi dei plugin mancanti — il CTD-al-load diventa diagnosi pre-lancio. IPC `saves:doctor`. Mai warning spuri: qualsiasi ambiguità → non-verificato silenzioso.
- Scartati consapevolmente (ricerca web round 3): parse PE dei DLL SKSE (Address Library check copre già il caso comune), validazione header ESP form 1.71, import BethINI, grass cache autopilota, QAC via SSEEdit (tool esterni assenti). 3 moduli nuovi = ~60 test aggiunti, suite 843 verde.

### Added — FOMOD-01: installer FOMOD headless (motore ufficiale Vortex) + scelte del curatore
- **`@nexusmods/fomod-installer-native`** (motore Vortex reale, .NET Native AOT, N-API 8 stabile — nessun rebuild tra versioni Electron/Node, prebuilds win32-x64): `electron/fomod/fomodApply.ts` (`runFomodHeadless`, `applyFomodInstructions` con journal RENAME + rollback + marker idempotente `.smm-fomod-applied.json`, varianti non scelte eliminate), `collectionChoices.ts` (parse `collection.json` della revision per le scelte del curatore), `engine.ts` (IPC `fomod:fetch-choices`/`scan`/`apply-all`).
- Le scelte per-mod del curatore **non sono nel GraphQL** delle Collection: vivono dentro il `collection.json` scaricabile dal `downloadLink` della revision (`fetchRevisionDownloadLink`, aggiunto a `electron/nexus/collections.ts`).
- Card **Strumenti → FOMOD** (Scarica scelte → Applica a tutte, progress + report). Build: `build.asarUnpack` per i file nativi del modulo + `build.npmRebuild:false` (il pacchetto shippa prebuilds; node-gyp lo romperebbe).
- Quirk API scoperti empiricamente (nessuna documentazione pubblica sufficiente): `scriptPath` = **directory root** della mod (non il path di `ModuleConfig.xml`, altrimenti l'engine lo concatena due volte), `preset` = **array** (mai oggetto, nemmeno vuoto).

### Added — INTEGRITY-01: provenienza API nel gate integrità + conflitti chirurgici + politica spazio
- **`decideIntegrity()`** (`electron/install/integrity.ts`): nuovo verdetto `'api-provenance'` — accettato **solo** senza hash atteso E quando l'URL è stato risolto dal resolver API autenticato per la coppia modId/fileId esatta (mai per URL diretti/arbitrari). Copre i file troppo recenti per l'indice `md5_search` di Nexus senza indebolire il fail-closed.
- **Conflitti chirurgici**: IPC `deploy:preview` (dry-run del piano reale di sovrascrittura) + `deploy:prefer` (alza `resolution_weight` della mod scelta) + sezione "Sovrascritture file" in pagina Conflitti con bottone "Inverti precedenza" — **mai** disattivazione della mod.
- **Politica spazio disco**: archivio eliminato di default dopo install riuscita (`deleteArchiveAfterInstall`, override `keepArchives`). Pulizia one-shot eseguita su dati reali: 1737 archivi, **73,8 GB liberati** (disco 94%→87%).

### Added — QUEUE-01: fix archivi RAR mascherati + retry bulk + budget plugin + preset ENB reali
- **`sniffArchiveKind()`** (`electron/install/extract.ts`): dispatch sui **magic byte reali** ("Rar!"/7z/zip) invece che sull'estensione — 12/14 download "falliti" erano in realtà **RAR serviti da Nexus con estensione `.7z`**, rifiutati dal 7za bundlato (senza codec Rar). Bottone **"Riprova falliti"** + IPC `download:retry-failed` (riusa la cache, rifà solo l'estrazione per i RAR).
- **Budget plugin** nel deployer: blocco pre-scrittura `plugin-limit` se si superano i **254 slot "full"** (ESM/ESP non-light, base+CC+mod) o i **4096 slot "light"** (ESL/FE), contati dai flag reali dell'header TES4.
- **Gestione preset ENB reale** (`electron/enb/`): `scan` nelle mod estratte, `apply` copia (non hardlink) nella root del gioco + backup `.smm-enb-bak` + manifest `.smm-enb-manifest.json`, `remove` ripristina; avviso se manca il core `d3d11.dll` (enbdev.com, non ridistribuibile).
- Fix minore: riconoscimento del nuovo formato URL Nexus (`games/<gioco>/collections/<slug>`) in `parseCollectionInput`.

### Added — DEPLOY-GAME-01: deploy nella Data del gioco reale
- `deployTarget: 'game'` in config + `resolveGameDataDir()`: senza MO2/VFS il gioco vede **solo** la propria cartella `Data`, quindi il deploy scrive lì direttamente (non più uno staging separato).
- **Reversibilità garantita**: file pre-esistenti nel target vengono salvati come `<file>.smm-vanilla.bak` prima di essere sovrascritti; il purge del manifest li **ripristina**. Le junction degradano a hardlink per-file (con backup) quando la directory di destinazione esiste già (caso normale su Data reale, es. `Data/SKSE`). Euristica di pulizia (`allowHeuristics`) disattivata quando il target è il gioco reale — solo purge esatto da manifest.

### Added — CRASH-01: analisi automatica crash dopo il lancio
- `electron/launch/crashLogAnalyzer.ts`: `parseCrashLog`/`findProbableCulprit`/`analyzeCrashLog` — parser puro per il formato Crash Logger SSE, verificato su un log reale da 835 righe (identifica correttamente il DLL colpevole in un caso sintetico; su log reali "solo moduli motore" riporta nessun colpevole invece di indovinare a caso).
- `crashEngine.ts`: `armCrashWatch`/`stopCrashWatch` — poll ogni 30s per 3h dopo ogni lancio riuscito (timer `unref()`'d, non blocca l'uscita dell'app), evento `crash:detected` → toast in `App.tsx` col modulo colpevole. IPC `crash:list-recent`/`crash:analyze` anche per l'uso manuale in Strumenti.
- Rimossa la card ENB **mock** in Strumenti (sostituita dalla card reale, vedi QUEUE-01 sopra).

### Added — SKSE-ONLY-01: avvio esclusivo via SKSE interno + ottimizzazioni performance
- **MO2 rimosso dal percorso di avvio di default**: `bootstrapper.ts` → `DEFAULT_BOOTSTRAPPERS = [skseBootstrapper, dragonLoaderBootstrapper]` (`mo2Bootstrapper` resta esportato ma non usato); `preflight.ts` → `resolveGameLaunchTarget()`/`executeLaunch` semplificati a **solo SKSE**, nessun ramo MO2. Il gioco moddato si avvia esclusivamente tramite "Skyrim AE Fantasy Launcher" col suo SKSE interno.
- **Ottimizzazioni performance** (da ricerca best-practice Electron): `Menu.setApplicationMenu(null)` in produzione, `spellcheck:false` in `webPreferences`, fallback anti-ghost-window (`setTimeout` show() a 5s), handler `did-fail-load`, `app.on('before-quit')` → checkpoint DB; `applyPragmas` esteso (`cache_size`/`temp_store`/`mmap_size`/`optimize`); `downloads:list` refactorato su un singolo prepared statement riusato.
- Settings: rimossi i campi MO2/percorso mods (non più pertinenti al flusso SKSE-only).

### Added — LOOT-MASTERLIST-01: masterlist LOOT reale (regole/gruppi/dirty-plugin)
- **`electron/plugins/lootMasterlist.ts`**: parser YAML (via `js-yaml`, gestisce anchor/alias/merge-key nativamente) della masterlist community reale `loot/skyrimse` (GitHub) — **verificato sul file reale**: 3162 plugin, 47 gruppi, 429 regole, 872 voci dirty, parse in 42ms. `fetchMasterlistYaml` scarica su richiesta esplicita (bottone "Aggiorna masterlist" in Strumenti — mai automatico).
- **`masterlistCache.ts`**: cache persistita su disco (`loadMasterlistCache`/`refreshMasterlistCache`/`mergeMasterlists`).
- **`dirtyPluginCheck.ts` + `crc32.ts`**: CRC32 (IEEE 802.3, implementazione pura, verificata contro il test vector standard `0xCBF43926`) per il match dei plugin "dirty" (ITM/UDR/deleted nav) contro le voci della masterlist.
- **`espParser.ts`**: parser puro dell'header binario **TES4** (magic, `HEDR`, subrecord `MAST` per i master reali, gestione del subrecord esteso `XXXX` necessario per l'`ONAM` grande di USSEP) — verificato **355/355** su plugin reali.

### Added — CATALOG-REBUILD-01: svuotamento catalogo + import diretto da Nexus Collections v2
- **Bottone "Svuota catalogo"** (IPC `catalog:wipe`): cancella `modlist_catalog`+`downloads`+`mods` in transazione e imposta il flag persistito `catalogSeedDisabled`. **Rimossa la `useEffect`** in `Catalog.tsx` che ri-seedava automaticamente il bundle statico ad ogni mount — causa della regressione ricorrente per cui il catalogo "resuscitava" da solo con `nexus_id` storicamente sbagliati anche dopo uno svuotamento voluto.
- **`electron/nexus/collections.ts`**: `parseCollectionInput` (slug nudo o URL, tollerante ai delimitatori) + `fetchCollectionRevision` — interroga il **GraphQL v2 ufficiale** di Nexus (`collectionRevision(slug, revision)`) invece di dipendere dal pacchetto npm pubblicato `@nexusmods/nexus-api` (tarball 1.1.5, verificato via `npm pack`: **non contiene ancora** i metodi collections presenti solo su GitHub master). `buildCatalogRowsFromCollection` produce righe con `nexus_file_id` sempre valorizzato (mai stimato).

### Added — LOADORDER-01: load order LOOT-like sui master reali dei plugin
- **`electron/plugins/lootSort.ts`**: topological sort con partizione master-space, blocco duro su master mancante o ciclo (sui master reali/fallback), regole soft con scarto su ciclo, arricchito da `groupRank` (ranking dei gruppi della masterlist community).
- **`electron/deploy/lootOrder.ts`**: adapter che collega `espParser`+`lootSort`+masterlist al deploy — legge i master **dai binari reali dei plugin**, mai dal catalogo (che resta solo fallback quando l'header è illeggibile).

### Fixed — LAUNCH-FIX-01: riconoscimento naming AE dell'Address Library
- Il gate di avvio riconosce ora `versionlib-*.bin` (naming reale AE) oltre al nome legacy, evitando falsi negativi sul controllo Address Library presente.

### Added — DEPLOY-SYNC-01: bridge mass-sync→mods + load order/manifest/plugins.txt
- **`electron/deploy/`**: piano di deploy dependency-aware (ordine di caricamento), **manifest** (`deploy:run`/`deploy:purge` con purge esatto da manifest, non euristico), scrittura `plugins.txt` di sistema, UI dedicata. Bridge che collega le estrazioni del mass-sync alla tabella `mods` + normalizzazione dei mod con wrapper `Data/` nell'archivio.

### Added — CATALOG-VALIDATE-01: pruning collezione + validazione fail-safe
- Pruning delle righe catalogo dal dominio DOMAIN + validazione dello schema download (righe malformate scartate invece di propagare un mod non installabile).

### Hardened — DISK-GATE-02: gatekeeper disco unificato fail-closed
- Consolidato il pre-flight disco (mass-sync + install) dietro un unico gatekeeper fail-closed; chiuse le note review avversariali della revisione precedente (PRECHECK-01).

### Changed — CI/DEPS-01: Electron 43 + toolchain aggiornata
- Bump **Electron 43.1.0**, **better-sqlite3 12.11.1**, **electron-builder 26**, **Vite 8** (rolldown, no esbuild), **Vitest 4**, **Node 24** (SRB-002). CI: `actions/checkout`/`actions/setup-node` a v5.

### Added — MASS-INSTALL-01: budget ESL/254 + traduzioni ITA + worker a due fasi
- Resolver budget plugin "full"(254)/"light"(ESL,4096) + resolver traduzioni ITA + worker a due fasi (scan poi install) + profilo qualità texture (2K/4K) con selezione variante per-mod + pool install a concorrenza limitata (cap 3, stato in coda).

### Added — CATALOG-DEDUP-01: modlist completa dal backup Vortex
- Import del modlist de-duplicato (~4568 voci) dal backup Vortex; rimossi i doppioni cross-source (id placeholder curato vs id reale Vortex).

### Hardened — SECURITY-01/SRB-001: chiusura red-team + residual findings
- Batch di hardening sicurezza: fail-closed su install/hash-gating, confinamento IPC a root whitelisted (fs read-dir/file-open/reveal-folder), consenso esplicito per `nxm://`, anti-rollback freshness gate sui manifest di update firmati, sanitizzazione risposta validazione API Nexus, validazione dei path in `settings:set` + rifiuto exec UNC al lancio, purga plaintext residuo, guardia clock-rollback.

### Added — LOADORDER-EDITOR-01: editor ordine caricamento interattivo
- Editor drag-and-drop con toggle e salvataggio, write-back con backup, componente di visualizzazione ordine caricamento.

### Added — AUTODETECT-01: rilevamento automatico percorsi gioco+tool (zero config)
- **Modulo backend** `electron/tools/autoDetect.ts`: elimina la configurazione manuale della schermata "Percorsi Gioco e Strumenti". Sequenza: (a) **cartella Skyrim** via registro Steam (riusa `detectSteamEnv`, nessuna nuova dipendenza, read-only); (b) **scansione tool** — `scanForExes` (DFS a profondità limitata, default 3, denylist `SKIP_DIRS` per Windows/WindowsApps/node_modules/…, single-pass multi-tool, primo match per tool) su root standard (`standardToolRoots`: cartella gioco + parent, `C:\Games|Modding|Mods|Tools|Modlists|Wabbajack`, Desktop/Downloads/Documents, `%LOCALAPPDATA%\ModOrganizer|LOOT`, Program Files, librerie Steam) per `ModOrganizer.exe` (+ cartella `mods` derivata), `LOOT.exe`, `SSEEdit(x64/64).exe`, `DynDOLODx64/DynDOLOD.exe`, `xLODGen(x64).exe`; 7-Zip via `detect7zPath`, Pandora via `findPandoraExe`; (c) **fallback silenzioso** — i tool non trovati restano vuoti, mai bloccante.
- **Cablaggio**: IPC `settings:auto-detect` + helper `applyDetectedPaths(det, {fillEmptyOnly})` in `main.ts` (persiste solo i percorsi trovati nel DB cifrato via `store.set`; `fillEmptyOnly` non sovrascrive mai valori già impostati dall'utente) + **auto-run all'avvio** (`setImmediate` in `whenReady`, `fillEmptyOnly:true`). `window.api.settings.autoDetect` (preload + tipi). Bottone **"Rileva Automaticamente"** in cima alla sezione "Percorsi Gioco e Strumenti" (`Settings.tsx`, spinner + feedback), rifà la scansione on-click e salva.
- **+7 test** (`autoDetect.test.ts`: `scanForExes` profondità/skip-dir/case-insensitive/alt-name, `standardToolRoots` dedup+solo-esistenti, `detectToolPaths` fallback silenzioso + mappa vuota). **264 test** verdi, `tsc`/`vite build` OK, bottone verificato nel preview (0 errori console).
- **Detection reale verificata** (~2,4s): `gamePath = c:\librearia steam\…\Skyrim Special Edition` (registro Steam), `sevenZipPath = C:\Program Files\7-Zip\7z.exe`, `pandoraPath = C:\Pandora\…v4.3.1\Pandora Behaviour Engine+.exe`; MO2/LOOT/SSEEdit/DynDOLOD/xLODGen non installati → **lasciati vuoti** (fallback silenzioso confermato).

### Executed — Build Skyrim reale: download 271 boot-mod + deploy Tier-0 (BOOT_GATE_01)
- **EXECUTE-BOOT-01**: auth Nexus live PASS (Premium, X-RL-Daily 20000). Harness `scripts/exec_boot.mjs` (concorrenza 4, resolve→download→md5 vs backup→estrazione) → **271/271 boot-mod, 0 fail**, cache `data/boot_cache/downloads` (7,13 GB) + estratti in `data/StockGame/mods` (271 cartelle, 22,06 GB).
- **Tier-0 (manuale, fuori backup)**: Address Library AE (modId 32444) + Engine Fixes Part 2 (modId 17230) flaggati MANUAL_REQUIRED. Engine Fixes AIO 7.0.19 = VERSION_CHANGED (contiene `d3dx9_42.dll`+`EngineFixes.dll`+`EngineFixes.toml`, **non** `tbb.dll/tbbmalloc.dll`). Utente ha deployato manualmente nel gioco Steam: `Data\SKSE\Plugins\{EngineFixes.dll,EngineFixes.toml,versionlib-1-6-1170-0.bin}` + root `d3dx9_42.dll`. `versionlib-1-6-1170-0.bin` copiato via app (795129 B, match).
- **Stato osservato (read-only)**: boot-critici (SKSE 2.2.6 + Address Library 1.6.1170 + Engine Fixes) PRESENTI nel gioco reale `C:\Librearia steam\…\Skyrim Special Edition` → boot-critical READY. I 271 mod restano in `StockGame/mods` (cache isolata), **non deployati nel gioco**; `plugins.txt` = 0 attivi → SkyUI/MCM/CrashLogger non attivi. `data/StockGame` = staging (PORTABLE_GAME isolato), **base vanilla NON assemblata**. Avvio reale solo da GAME_ROOT (`skse64_loader.exe`); FIRST-BOOT live = compito utente (non automatizzabile da me).
- Note: nuovi harness `scripts/{exec_boot.mjs,e2e_*.mjs,sync_*.ts}` (diagnostici riusabili). Suite app invariata (**257 test**, `tsc`/build verdi).

### Added — PANDORA-REGISTER-01: detection Pandora (read-only, no esecuzione)
- `electron/tools/pandora.ts`: `findPandoraExe`/`detectPandora`/`pandoraRoots` (IO iniettato via `FsProbe`, puro+testabile). Cerca `Pandora Behaviour Engine+.exe` nei root candidati (setting `pandoraPath` → `C:\pandora` → comuni) e in 1 livello di sottocartelle; preferisce la build **versionata** alla "Preview". **Non esegue mai Pandora, non genera output.**
- IPC `tools:pandora:path` (`main.ts`): rileva, **persiste `pandoraPath`** nel settings se trovato, ritorna `{path, exePath, exeFound, candidatesTried}`. `window.api.tools.pandoraPath` (preload+tipi). Indicatore **"Pandora ✓ Rilevato"** nel pannello "Strumenti esterni" della Dashboard (fetch read-only al mount, degrada a "Non config." nel browser).
- **6 test** (detection profonda 1 livello, preferenza versione vs Preview, root=exe, root=engine-folder, assenza, `pandoraRoots`). **257 test** verdi, `tsc`/`vite build` OK.
- **Detection reale verificata**: `C:\Pandora\Pandora Behaviour Engine v4.3.1-beta-133232-…\Pandora Behaviour Engine+.exe` (118 MB) — scelta la build versionata, non la Preview.

### Added — PRECHECK-01: pre-flight disco aggregato (bloccante)
- **Funzioni pure** in `electron/sync/massSync.ts`: `pendingBytes()` (somma `fileSize` dei soli mod non ancora estratti) + `computeDiskPreflight()` (`required = pending × extractionOverhead × safetyFactor`, default **1.10 × 1.15**, entrambi configurabili) + `diskPreflight()` (IO wrapper che legge lo spazio libero del volume StockGame via dep iniettato).
- **Enforcement bloccante**: `runMassSync` chiama il pre-flight **prima di qualunque download/resolve** e lancia fail-closed se `margine < 0` (override `skipDiskCheck` per i test). Dep `freeSpace(path)` aggiunto a `MassSyncDeps`, cablato in `main.ts` su `getFreeSpace` (`install/diskSpace.ts`). Fattori da settings `extractionOverhead`/`diskSafetyFactor`.
- **UI Dashboard**: IPC `sync:preflight` (+ `window.api.sync.preflight`) → card **GO/NO-GO** con richiesto / disponibile / margine; quando NO-GO avvisa che il sync sarà bloccato. Tipo `DiskPreflightUI`.
- **+5 test** (computeDiskPreflight fattori/margine/ok, pendingBytes esclude i presenti, blocco fail-closed prima del download, bypass skipDiskCheck). **251 test** verdi, `tsc`/`vite build` OK.
- **Verifica su dati reali**: 4.568 mod = pending 329,5 GB → **richiesto 416,8 GB** vs **276,0 GB liberi su C:** → **NO-GO (margine −140,8 GB)**. Il blocco funziona: il disco attuale non può ospitare la modlist mentre Steam (236 GB) + archivi Vortex (329 GB) la occupano. Limite noto: 1.10 è una stima per-difetto (le texture si espandono di più) e la cache archivi è trattenuta → alzare i fattori per liste pesanti.

### Hardened — Cabl-01-Hardening: mass-sync affidabile per 4.568 mod / 329 GB
- **Retry/backoff/circuit-breaker condivisi** (`electron/install/retryPolicy.ts`, nuovo): estratti dalla logica inline di `downloadManager` in UN modulo usato da **entrambi** (download queue + mass-sync). `isRetryableError` classifica 429/5xx (incl. Cloudflare 520-527)/ECONNRESET/ETIMEDOUT/UND_ERR_*/TLS reset/CF transient + "download incompleto"; **NON** ritenta 401/403/404/4xx. `backoffWithJitter` (equal jitter, cap 8s). `CircuitBreaker` (halt su N fallimenti consecutivi). `withRetry`/`abortableSleep` AbortSignal-aware. `downloadManager` **refactorato** per usarlo (niente policy duplicata). 11 test.
- **Telemetria byte-precisa**: eliminato `bytesDownloaded += fileSize`; ora somma i **byte reali** emessi da `streamDownload` (completati + live degli attivi). Espone `throughputMBps` (EMA) ed `etaSeconds`. Barra overall **byte-monotòna** (mai 100→0→100).
- **Progress dettagliato**: `active[]` = `{name, phase:'downloading'|'verifying'|'extracting', downloaded, total, percent}`. La UI mostra la **fase** (chip) così il reset % per-mod tra download ed estrazione non confonde.
- **Abort dell'estrazione**: `extractArchive` ora accetta `AbortSignal` → `proc.kill()` del processo 7-Zip (prima NON interrompibile); fallback adm-zip abortabile tra le entry. `massSync` pulisce la `destDir` parziale su fallimento (un resume non la scambia per "fatta"); il `.part` resta per riprendere il download.
- **Smoke reali superati** (harness `scripts/sync_batch_smoke.ts`): **10 mod @ conc.3** e **50 mod @ conc.5**, entrambi 5/5 check verdi: tutti i mod OK, **retry+resume reale** (drop iniettato @40% → `↻ retry` → resume via Range), nessun `.part` residuo, nessun active slot trapelato, estrazione solo nello StockGame.
- **246 test** verdi (+17: 11 retryPolicy, 6 massSync hardening), `tsc`/`vite build` OK. Limite noto: throughput/ETA non esercitati dai mod minuscoli del smoke → coperti dai unit test deterministici.

### Added — Cabl-01: flusso di massa reale cablato nella Dashboard
- **Orchestratore mass-sync** (`electron/sync/massSync.ts`): porta in produzione la logica del batch, guidando l'intera modlist (4.568 mod dal backup) attraverso le primitive già testate — `resolveDownloadLink` (Premium) → `streamToFile` (download resumibile .part+Range) → **md5 vs backup** (fail-closed) → `extractArchive`. Concorrenza da impostazioni, idempotente (salta i mod già estratti), cancellabile.
- **Isolamento StockGame garantito** (`assertIsolated`): il sync rifiuta fail-closed se il target coincide/si sovrappone all'install Steam; ogni estrazione va SOLO in `StockGame/mods`, con guard di path per-file (`isPathInside`). Il Skyrim di Steam resta intatto. **9 test** (isolamento, md5 mismatch→rimozione, skip idempotente, concorrenza, cancellazione).
- **Bottone "Sincronizza e Avvia" cablato**: `runSync` ora apre una **conferma scale-aware** (~329 GB, solo StockGame), chiama `window.api.sync.start()` e mostra una **barra di progresso live** (mod fatte/totali + GB + download concorrenti + Annulla) via evento `sync:progress`. Sorgente: backup persistito → fallback scan Vortex. Gating: richiede Nexus abilitato + chiave. IPC `sync:start|cancel|status`, `window.api.sync`, tipo `SyncProgressUI`.
- Fix sicurezza UX: `onClick={() => runSync()}` (l'evento mouse non bypassa più la conferma). **229 test** verdi (+9), `tsc`/`vite build` OK, Dashboard verificata nel preview (0 errori). NB: il download reale dei 329 GB parte SOLO al click dell'utente con conferma — non eseguito automaticamente.

### Verified + Added — E2E-BATCH a scala + pannello UI StockGame
- **Batch reale 4/4 superato** (formati misti + file pesante + concorrenza + resume): `.7z` Believable Weapons (705 file), `.zip` Fluted Armour (18), `.rar` TsunDal Boss Overhaul (52), **`.zip` 1,01 GB** Nordic Northern Roads (110 file, 1,28 GB estratti). Tutti con **md5 ✓** vs backup e `7z t` ✓. Scoperta formati via `files.json` (estensione reale senza consumare link). **Concorrenza 3** simultanei provata; **resume self-test**: caduta simulata a 6 MB → ripreso via HTTP Range → completato integro. Harness `scripts/e2e_batch.mjs` (`--plan` per sola scoperta). Fix: parsing `content-range` con `Number()` (no overflow bitwise >2 GB).
- **Pannello UI StockGame** (`src/components/ui/StockGamePanel.tsx`) nella Dashboard: detect sorgente/target/peso-vanilla, selettore hardlink/copia, **barra di progresso live** (evento `stockgame:progress`), riepilogo risultato + warning file mancanti, log nella console. Degrada con grazia nel preview browser (nessun `window.api`). Tipi `StockGameDetect/Progress/Result` + `window.api.stockGame`. Verificato nel preview (render OK, 0 errori console).
- Artefatti di test (~2,6 GB) ripuliti dopo la validazione (tenuto `data/e2e/batch.log`). `tsc`/`vite build` OK, **220 test** verdi.

### Verified — Pipeline download E2E REALE superata (Nexus Premium)
- **Primo download reale end-to-end** completato con account Nexus Premium vero: `4k Farmhouse Fences SE` (modId 38912, file 153295, 50 MB) selezionato dal backup → **link CDN risolto** via `download_link.json` (host `cf-files.nexusmods.com`) → **download streaming** 50 MB → **md5 combaciante** col backup (`30423fa1…42ea1e`, fail-closed) → **`7z t` "Everything is Ok"** → **estrazione** 8 file (96,3 MB: texture .dds + mesh .nif) nella cartella isolata `data/StockGame/mods/`.
- Prova che l'installer è **autonomo sul percorso reale** (key→CDN→download→integrità→estrazione) per una singola mod. Harness riusabile `scripts/e2e_download.mjs` (chiave SOLO da `$NEXUS_API_KEY`/`.env`; target override `<modId> <fileId>`). Conferma anche che i `fileId`/`md5` nel backup sono **vivi e corretti**.

### Added — Backup collezioni Vortex + StockGame isolato + sblocco auth Nexus
- **Backup reale collezioni Vortex** (`data/vortex-collections-backup.json`, ~4 MB): export READ-ONLY dei 3 `collection.json` reali (DOMAIN AE NSFW AIO 4949, Mon Skyril 718, MY MODS 244) → **5.911 entries Nexus**, de-duplicate a **4.568 mod uniche** (tutte con modId+fileId+md5+fileSize), **329,51 GB** di archivi noti. Hash di integrità `sha256` ricalcolato e combaciante. Mette al sicuro la fonte di verità (modId/fileId) prima di qualsiasi pulizia di Steam. Generato da `scripts/_export_collections_backup.mjs` (logica fedele a `vortex/scan.ts`).
- **Correzione narrativa peso:** i "300 GB" NON sono irraggiungibili-senza-texture come detto prima — con la 3ª collezione il modlist reale dell'utente è **329 GB**. Era una stima vecchia su 2 collezioni/833 mod. Il `modlistCatalog.ts` curato (35 GB) è una lista a parte; la lista vera da installare sono i 4.568 mod del backup.
- **StockGame builder** (`electron/install/stockGame.ts`): crea una copia **isolata e vanilla** di Skyrim SE/AE così il setup moddato non tocca mai l'install Steam reale. **Companion-safe** (READ-ONLY sulla sorgente, scrive solo nel target). Classificatore whitelist puro (`classifyRootEntry`/`classifyDataEntry`): copia solo base/DLC/Creation-Club BSA+ESM, eseguibili root, DRM dll, Video/Strings; **salta** tutto il resto (mod BSA, loose meshes/textures/scripts, SKSE, ENB). Su una install moddata da 236 GB pesca solo il ~vanilla. **Hardlink-first** (stesso volume = 0 byte extra) con fallback copia cross-volume; variante `createStockGameAsync` che cede il loop (no freeze UI su copie multi-GB). Verifica i file vanilla richiesti. IPC `stockgame:detect`/`stockgame:create` + evento `stockgame:progress` + `window.api.stockGame`. **10 test**.
- **Sblocco auth Nexus:** interruttore in-app `nexusEnabled` (Impostazioni → "Abilita download reali (Premium)") che attiva il provider HTTP **senza env var**; backend `main.ts` ora gata su `NEXUS_ENABLED` env **oppure** setting. La chiave resta cifrata in `app_secrets` (DPAPI) e iniettata sia nel provider sia nel `download_link`. Tipo `AppSettings.nexusEnabled`.
- Steam reale rilevato: `c:\librearia steam` · Skyrim SE/AE **236,23 GB** (gioco con mod deployati: 272 BSA vs ~60-70 vanilla). **220 test** verdi (+10), `tsc`/`vite build` OK.

### Added — Foundation Nolvus Ascension ("il necessario") nel catalogo
- **+12 framework/SKSE-plugin base** dalla guida ufficiale Nolvus Ascension (`nolvus.net/guide/asc/skse`), ID Nexus reali verificati: PapyrusUtil 13048, po3 Papyrus Extender 22854, JContainers 16495, .NET Script Framework 21294, Base Object Swapper 60805, KID 55728, ConsoleUtilSSE 24858, FISSES 13956, Fuz Ro D'oh 15109, More Informative Console 19250, Better Jumping 18967, Custom Skills Framework 41780. Catalogo 115→**127 voci**.
- Sono **le dipendenze base** richieste dalle mod di contenuto (script libs, distributori, hook nativi): non-grafiche, peso trascurabile (~32 MB) — "il necessario" riguarda completezza/dipendenze, non il peso. Esclusi gli elementi **grafici** della stessa pagina (ENB Helper, Skyrim Upscaler).
- Fonte Nolvus confermata affidabile (cross-check su nexusmods.com: FISSES 13956, Custom Skills 41780, PapyrusUtil 13048, BOS 60805 tutti corretti). **210 test** verdi, `tsc`/`vite build` OK.

### Added — Catalogo esteso con mod non-grafiche reali (+ ID corretti)
- **+12 mod reali verificate** su nexusmods.com (nessuna grafica/texture): nuove terre/quest [Legacy of the Dragonborn 11802, Beyond Skyrim Bruma 10917, Forgotten City 1179, Wyrmstooth 45565, Clockwork 4155, Project AHO 15996, Moonpath 4341, VIGILANT 11849], audio [Immersive Sounds 523, Audio Overhaul 12466], combat [Wildcat 1368], survival [SunHelm 39414]. Catalogo: 103→**115 voci**, ~24.6→**35.4 GB**.
- **Corretti 6 ID Nexus errati** di mod già presenti (link di download reali): SPID 96664→36869, USSEP 7198→266, Apocalypse 1845→1090, Helgen Reborn 12997→5673, Inigo 19820→1461, Lucien 52343→20035.
- **Nota onesta sul peso:** i ~300 GB di Nolvus sono dominati da **texture/grafica** (categoria esclusa per scelta). I contenuti non-grafici (quest/follower/audio/gameplay) sono intrinsecamente piccoli: la loro somma realistica resta nell'ordine delle decine di GB, non centinaia. Posso aggiungere altre mod verificate su richiesta, ma 300 GB non è raggiungibile senza grafica.
- ID verificati via WebSearch (diversi differivano dalla memoria — es. Forgotten City 1179, Wyrmstooth 45565, Lucien 20035). **210 test** verdi, `tsc`/`vite build` OK; verificato che le 12 nuove voci e i 6 ID corretti compaiono nell'API catalogo.

### Added — Dashboard "Sincronizza e Avvia" (counter, gauge 300 GB, console live, opt-in)
- **Pannello statistiche:** counter animato (count-up) delle **mod uniche** post-dedup Vortex + **gauge circolare SVG** dello spazio occupato verso il **target 300 GB** (`DiskGauge`). Dati dal `vortex:scan` (`totalBytes` aggiunto allo scan + store `vortexStats`/`loadVortexStats`).
- **Pulsante centrale "Sincronizza e Avvia"** (stile Nolvus, gradiente + glow): esegue la pipeline (scan → catalog → install → Pandora) **solo dopo il clic**, con log per ogni step.
- **Toggle opt-in "Avvio automatico a zero-clic all'apertura":** interruttore con **pop-up di conferma** (`window.confirm`); se attivo la pipeline parte sola all'apertura (consenso dato all'attivazione). Persistito in `settings.autoSyncOnLaunch`.
- **Console di Log in tempo reale** (`LogConsole`): finestra scorrevole in fondo, auto-scroll, righe color-coded per livello, da uno store buffer (`activityLog`/`pushLog`/`clearLog`, cap 200). Mostra es. "Scansione cartella completata", "Rilevate 833 mod uniche", "Catalogo generato", "Pronto per l'avvio".
- Mock browser arricchito (~833 mod / ~288 GB) per un preview coerente. **210 test** verdi, `tsc`/`vite build` OK; verificato nel preview (counter 833, gauge 288/300 GB, console 13 righe dopo il clic).

### Added — Importer Vortex (collezioni Nexus) + automazione gated all'avvio
- **`electron/vortex/scan.ts`:** scansione **read-only** della staging folder Vortex (`…\Vortex\skyrimse\mods`). Fonte autorevole = i **`collection.json`** (`source.modId`/`fileId`/`md5`/`fileSize`/`optional`/`phase`) — **non** `__vortex_meta.json` (inesistente: Vortex usa il LevelDB `state.v2`). Parser nome-cartella per le mod fuori collezione, **de-duplicazione** (collezione > cartella, required > optional, fileId più recente), build `catalog.json` con flag `required_resource` per le **risorse base** (SKSE, Address Library, USSEP). +9 test.
- **Validato sui dati reali:** le 2 collezioni (`Mon Skyril`, `MY MODS`) → 962 entry → **833 mod uniche** (129 doppioni rimossi), base resources presenti.
- **Avvio automatico (sicuro):** la **scansione gira da sola all'avvio** (solo lettura, loggata). IPC `vortex:scan` / `vortex:build-catalog` (scrive `userData/vortex-catalog.json`). Override percorso via `settings.vortexPath`.
- **Pandora come gestore unico animazioni:** IPC `tools:launch-pandora` + pulsante **one-click consapevole** (con conferma) — esegue Pandora per rigenerare i file di comportamento come **step esplicito**, mai silenzioso a ogni apertura.
- **UI Strumenti → "Import da Vortex":** Scansiona / Genera catalog.json / Rigenera behaviour (Pandora), con conteggi collezioni/uniche/doppioni.
- **210 test** verdi, `tsc`/`vite build` OK; pannello verificato nel preview.

> **Nota architetturale:** richiesto in C#, implementato in **TypeScript** (lo stack reale dell'app — C# sarebbe codice morto). Il download/estrazione e Pandora **non** girano in automatico a ogni avvio (azioni distruttive/irreversibili che scaricano da Nexus e modificano il gioco): restano dietro consenso esplicito one-click, coerentemente con la companion mode.

### Added — Sezione "Licenze di terze parti" (conformità LGPL + unRAR)
- **`src/data/licenses.ts`:** testo integrale della licenza 7-Zip (GNU LGPL + restrizione unRAR + BSD-3) incluso **come stringa-asset nel bundle** (sempre presente → conformità garantita anche offline/preview) + elenco componenti (7-Zip, better-sqlite3, Electron, React, axios, adm-zip).
- **UI Impostazioni → "Licenze di terze parti":** chip per componente + **scroll view** (`<pre>` `max-h-72 overflow-y-auto`, focusabile/aria-label) con la licenza 7-Zip completa, come richiesto dalla clausola *"Redistributions in binary form must reproduce related license information"*.
- Licenza spedita **anche come file** `resources/7zip-full/7-Zip-License.txt` accanto al binario; testo allineato alla versione 7-Zip **26.01** effettivamente bundlata (termini identici al file fornito).
- **Test (+7):** `licenses.test.ts` (guardia di conformità: clausola di ridistribuzione, LGPL, unRAR, BSD-3, copyright mai troncati). **201 test** verdi, `tsc`/`vite build` OK; scroll view verificato nel preview (scrollabile, contiene unRAR/LGPL).

### Added — Supporto .rar nativo: 7-Zip di sistema (primario) + full 7z bundlato (fallback)
- **`.rar` risolti senza memory leak** (niente WASM in-memory): `resolveRar7z()` usa il 7-Zip **completo di sistema** rilevato da `detect7zPath` (path configurato o installazione standard) come **interprete primario**; se assente, **fallback al full 7-Zip bundlato** (`7z.exe`+`7z.dll` 26.01, supporta Rar/Rar5 — verificato) come **risorsa esterna asar-unpacked** (`extraResources` → `process.resourcesPath/7zip-full`); ultima risorsa: notifica chiara all'utente.
- `extract.ts`: opzione `full7zPath` (per `.rar`) separata da `bundled7zaPath` (standalone, `.7z/.zip`). `installManager` passa `resolveRar7z(<configurato>)`.
- **Impostazioni** aggiornate: `.7z/.zip/.rar` tutti out-of-the-box; il campo 7-Zip di sistema è ora un **override opzionale** per i `.rar`.
- **Test (+6):** `sevenZip.test.ts` (catena `resolveRar7z`: sistema→bundled→null, override) + `extractNative.test.ts` (il full 7z bundlato **espone realmente i codec Rar/Rar5**). **194 test** verdi, `tsc`/`vite build` OK.
- Licenza 7-Zip inclusa in `resources/7zip-full/7-Zip-License.txt` (estrazione consentita; LGPL + clausola unRAR).

### Changed — Estrazione nativa .7z/.zip senza configurazione (7-Zip bundlato)
- **`7zip-bin` bundlato** (binario prebuilt, **niente C++/compilazione**): `.7z` e `.zip` (anche multi-GB) si estraggono **out-of-the-box**, senza che l'utente configuri alcun eseguibile. `electron/install/sevenZip.ts` → `bundled7zaPath()` (+ `toUnpackedPath` per app.asar→app.asar.unpacked); `asarUnpack` + external in vite per `7zip-bin`.
- **`extract.ts` format-aware:** `.7z`/`.zip` via 7za bundlato (override col 7-Zip di sistema se configurato); `.rar` richiede il 7-Zip **completo** di sistema (lo standalone 7za 21.07 non ha il codec Rar — verificato empiricamente) con messaggio chiaro; fallback adm-zip solo per `.zip` senza alcun 7-Zip.
- **Offloading dalla UI:** l'estrazione gira in un **processo figlio** (`spawn`), quindi né il renderer né (in modo bloccante) il main thread sono toccati; **progress dettagliato** via `-bsp1` → evento `install:progress` (percentuale realtime), già cablato in `installManager` + UI Download.
- **Impostazioni** riformulate: 7-Zip ora **opzionale** (incluso per .7z/.zip; di sistema solo per i .rar).
- **Test (+5):** `extractNative.test.ts` (crea/estrae un `.7z` e `.zip` reali col 7za bundlato + progress, **zero config**), `sevenZip.test.ts` (path bundlato + asar-unpacked). **188 test** verdi, `tsc`/`vite build` OK; `7zip-bin` esternalizzato nel bundle electron.

### Added — Pre-flight spazio disco (ispirato all'API installer Nolvus)
- Analisi del `Vcc.Nolvus.Api.Installer.dll` (client API proprietario Nolvus) → reference completa in `docs/NOLVUS-API-REFERENCE.md` (route, DTO, auth Bearer). **Non integrato** (server proprietario auth-gated, fuori scope); usato per validare il nostro design e individuare feature di robustezza.
- **Applicato:** `electron/install/diskSpace.ts` (`assessDiskSpace`/`estimateInstallFootprint`/`getFreeSpace` via `fs.statfs`, fail-open su probe illeggibili) — ispirato a `DownloadSize`/`InstallationSize`/`ModsStorageSpace` di Nolvus. Cablato in `installManager`: **prima di estrarre** un archivio multi-GB stima l'ingombro e blocca con messaggio chiaro se il volume mod è troppo pieno, invece di fallire a metà unpack. +8 test. **183 test** verdi, `tsc`/`vite build` OK.

### Added — Protocol handler nxm:// (download da Nexus, Premium + non-Premium)
- **`electron/nexus/nxm.ts`:** parser `parseNxmUrl` (`nxm://<game>/mods/<id>/files/<fid>?key=&expires=&user_id=`), `findNxmUrl` (intercetta l'URI dall'argv), `createNxmDownload` (inserisce la riga download con `nxm_key`/`nxm_expires`). +8 test.
- **Migrazione v5:** colonne `nxm_key`/`nxm_expires` su `downloads` → il flusso **non-Premium** inoltra key/expires al `download_link`; il **Premium** risolve da mod/file id.
- **`main.ts`:** `app.setAsDefaultProtocolClient('nxm')` (dev: execPath + script; packaged: exe) + `protocols` in electron-builder. Pattern **single-instance rigoroso**: la seconda istanza estrae l'URI da `argv` nel `second-instance`, lo passa alla primaria che **focuses + accoda** nella pipeline; cold-start gestito da `process.argv`, buffer `pendingNxm` finché DB/queue pronti; `open-url` per macOS.
- **`downloadManager.resolveUrl`** inoltra `key`/`expires`; **renderer** (`App.tsx`) su evento `nxm:queued` naviga a Download + toast.
- **175 test** verdi, `tsc` 0 errori, `vite build` OK.

### Changed — Chiave API Nexus persistita nel DB SQLite (cifrata)
- **Migrazione v4** + `electron/db/secrets.ts`: nuova tabella `app_secrets (name, value, updated_at)`. La chiave API Nexus (inserita **manualmente** dall'utente, niente OAuth) è persistita qui **sempre cifrata a riposo** (OS keychain / Windows DPAPI via `safeStorage`) — il file DB non contiene mai la chiave in chiaro.
- **`main.ts`:** gli handler `settings:get/set/get-all` instradano i `SECRET_KEYS` al DB cifrato; **migrazione automatica** della vecchia chiave da `electron-store` al DB al primo avvio (e rimozione dal vecchio store). Il client di rete (`downloadManager.getApiKey`) e il provider Nexus leggono la chiave dal DB e la iniettano come header `apikey` (o `Authorization: Bearer`) nelle richieste reali → risoluzione dei `download_link` reali.
- **+6 test** (`secrets.test.ts`: round-trip, **valore salvato come ciphertext mai in chiaro**, overwrite, delete su valore vuoto, v4 crea la tabella). Smoke aggiornato (user_version 4 + `app_secrets`). **167 test** verdi, `tsc` 0 errori, `vite build` OK.
- **7-Zip:** confermato `C:\Program Files\7-Zip\7z.exe` presente e rilevato dall'auto-detect (le `.lnk` del menu Start puntano al GUI `7zFM.exe`, non alla CLI necessaria).

### Added — Client Nexus download_link + validazione 7-Zip
- **`electron/nexus/downloadLink.ts`:** resolver dell'endpoint reale `api.nexusmods.com/v1/games/<game>/mods/<id>/files/<fid>/download_link.json` con header di auth corretti — `apikey: <key>` (chiave personale) **o** `Authorization: Bearer <token>` (OAuth, prioritario), `User-Agent`/`Accept`, più i parametri `key`/`expires` per i link nxm non-premium. Mappatura errori parlante (401/403 → "richiede Premium", 404, 429). Cablato in `downloadManager.resolveUrl`. +10 test.
- **`electron/install/sevenZip.ts` + IPC `tools:validate-7z`:** auto-detect del 7z.exe (path configurato o install standard), **validazione reale** lanciando il binario e leggendo il banner/versione. Persistenza via store impostazioni. +5 test.
- **UI Impostazioni:** nuova sezione *Estrazione archivi (7-Zip)* con **Sfoglia / Rileva / Verifica**, indicatore stato (✓ valido + versione / ✗ assente o non valido) e **banner di avviso** (senza 7-Zip si estraggono solo i `.zip`, le mod pesanti `.7z`/`.rar` fallirebbero). `tools.validate7z` esposto in preload + mock.
- **161 test** verdi, `tsc` 0 errori, `vite build` OK; UI verificata nel preview (Rileva → valido v24.07, Verifica path non-7z → non trovato).

### Added — Archivi reali: download resumibile + estrazione sicura (multi-GB)
- **`electron/install/downloadStream.ts`:** transfer streamato su `<dest>.part` (mai bufferizzato), **resume via HTTP Range** (riprende dal parziale invece di riscaricare GB), promozione **atomica** al nome finale solo a transfer completo (un parziale non viene mai scambiato per archivio valido), check integrità byte-count, progress throttled. HTTP client iniettabile → testabile.
- **`electron/install/extract.ts`:** estrazione **streaming** — 7-Zip preferito per ogni formato con **progress parsato (`-bsp1`)** drenando stdout/stderr (no deadlock pipe); fallback `.zip` adm-zip **gated** da cap dimensione (anti-OOM) + **guard zip-slip** (path traversal). `sha256File` streaming (RAM costante su file multi-GB) + `verifyArchiveHash`.
- **`installManager` cablato:** verifica sha256 **pre-estrazione** (da `delta_changeset.to_file_hash` del manifest firmato → archivio corrotto/manomesso **rifiutato, mai spacchettato**), progress estrazione live, **cleanup** della cartella mod a metà su errore.
- **`downloadManager` cablato** al core resumibile: `.part` + Range, resume mantiene il parziale, cancel rimuove tutti gli artefatti (incl. `.part`).
- **UI:** la pagina Download mostra lo stadio reale dell'installazione (*Verifica integrità…* / *Estrazione NN%*) via evento `install:progress` — l'interfaccia resta viva durante l'unpack di archivi pesanti.
- **Test (+13):** `extract.test.ts` (zip-slip, OOM cap, sha256 streaming, 7z-required, progress parse) + `downloadStream.test.ts` (transfer su socket reale, **resume Range**, restart su 200, fail-closed su stream troncato). Totale **146 test** verdi, `tsc` 0 errori, `vite build` OK.

### Added — Fetch HTTP reale del catalogo + verifica firma (Act-03)
- **`electron/delta/fetchCatalog.ts`:** transport sicuro del catalogo firmato — parsing con `new URL()` + **host allow-list** (match esatto/suffisso, no substring), **solo HTTPS** di default, **redirect rifiutati** (no bounce verso host interni / anti-SSRF), **cap dimensione** (Content-Length + byte effettivi) e **timeout** via `AbortController`. Fail-closed: nessun byte è attendibile finché non passa la trust boundary di `ingest`.
- **IPC `delta:ingest-url`** (`engine.ts`): fetch HTTPS host-allow-listed → poi la **stessa** verifica firma/counter/host di un manifest bundlato. Host configurabili via `NOLVUS_CATALOG_HOSTS` (default GitHub release hosts).
- **UI:** nuovo campo Impostazioni *URL catalogo firmato (HTTPS)*; la pagina Aggiornamenti usa il fetch remoto se impostato (mostra "Release verificata · fetch HTTPS"), altrimenti l'artefatto incluso ("bundle"). `delta.ingestUrl` esposto in preload + mock browser.
- **Test e2e `electron/delta/fetchCatalog.test.ts` (7):** server HTTP **reale** locale → fetch su socket vero → verifica firma → ingest+drift; più i casi fail-closed: host non consentito, protocollo non consentito, oversize, redirect rifiutato, e **body manomesso servito → la firma lo blocca** (la rete non bypassa la trust boundary).
- **133 test** verdi, `tsc` 0 errori, `vite build` OK; UI verificata nel preview (percorso bundle e percorso "fetch HTTPS").

### Added — Catalogo remoto reale firmato (T2) + badge drift in UI
- **Catalogo reale firmato** (`electron/delta/examples/catalog.remote.{json,signed.json}`): release `2026.06-core` counter 2, 6 mod con **`version` + `file_id` + `file_hash` sha256 reale (64 hex)** + `download_url` su host Nexus allow-listed. Prodotto da **`scripts/build_remote_catalog.mjs`** (parità Node del signer Python: stesso `canonicalJSON`, Ed25519 deterministico → firma verificabile dalla chiave **pinnata**; usato perché Python non è disponibile in locale).
- **Test `electron/delta/remoteCatalog.test.ts` (4):** verifica contro la chiave pinnata, schema reale per ogni mod (sha256 64-hex, host consentito), **rifiuto del manifest manomesso**, e ingest via `DeltaService` con drift reale (CBBE `2.0 → 2.7.0` changed, SkyUI invariata, Address Library added).
- **UI badge "update disponibile":** la pagina **Aggiornamenti** ora ingerisce il catalogo reale e accende i badge app-wide; **Lista Mod** mostra per-riga il badge + transizione `versione → ultima` (tooltip), **Sidebar** mostra il conteggio aggiornamenti sulla voce *Aggiornamenti*. Azione store DRY `markDriftFromChangeset` riusata da `checkAllUpdates` e dalla pagina Aggiornamenti.
- **126 test** verdi, `tsc` 0 errori, `vite build` OK; verificato nel preview (tag `2026.06-core`, 2 badge con transizioni reali, badge sidebar = 2).

### Added — Delta reali: baseline snapshot + checkUpdates (chiude "Delta non applicati")
- **Causa radice individuata:** `installed_snapshot` (già esistente da migrazione v2, single source of truth del lato "from") era scritto **solo** da `finalizeApply`. Una modlist installata normalmente non aveva baseline → `check()` vedeva tutto come "added", impossibile un confronto incrementale reale.
- **`electron/delta/snapshot.ts` (`syncInstalledSnapshot`):** semina/riconcilia `installed_snapshot` dalla tabella `mods` (versione, file id/hash, load order delle mod installate con `nexus_id`), elimina le righe di mod non più installate, **preserva il `release_id`** di provenienza delta. Idempotente e persistente.
- **`DeltaService.checkUpdates(profileId)`:** rinfresca il baseline → diffa contro l'ultima release firmata ingerita (`catalog_release_mod`) via `computeChangeset` → ritorna il version-drift per-mod. Changeset **staged**, quindi applicabile con `apply()`/`finalize()` esistenti. IPC `delta:sync-snapshot` / `delta:check-updates`.
- **`store.checkAllUpdates` ricablato:** ora usa **prima** il motore delta (snapshot persistente vs manifest), con fallback alla query Nexus per-mod solo se nessuna release è stata ingerita. Rimosso il gate "API Key mancante" sul pulsante (il motore non richiede chiave). Mock browser allineato (`delta.syncSnapshot`/`checkUpdates`).
- Verificato: nuovo `electron/delta/snapshot.test.ts` (6 test: seeding, idempotenza, riconciliazione rimozioni, preservazione provenienza, drift reale changed/added, fail-closed senza manifest). **122 test** verdi, `tsc` 0 errori, UI: "Controlla tutte" → 2 aggiornamenti reali dal motore.

### Added — UI: motori esposti nel renderer (Blocco 6)
- **Pagina Aggiornamenti** (`src/components/pages/Updates.tsx`): cablata al motore delta via `window.api.delta.*` (ingest→check→list→apply→finalize). Stepper firma→delta→download→commit, conteggi added/changed/removed/reordered, changeset con transizioni di versione, commit gated. In Electron usa il motore reale firmato; nel browser il mock ne simula il flusso leggendo il tag della release firmata d'esempio.
- **Pagina Compatibilità** (`src/components/pages/Compatibility.tsx`): nuovo IPC `compat:analyze` (`electron/launch/compat.ts`) che unisce versione runtime Skyrim/SKSE (T5) e report modlist da `plugins.txt` del profilo MO2 attivo (T3). UI con classificazione ESM/ESP/ESL, budget load order 254, version drift e findings per severità.
- Mock browser esteso (`delta` + `compat`) con la **stessa firma** dell'IPC reale → pagine engine-agnostic. Estratta la derivazione plugin in `src/lib/plugins.ts` (riusata da Plugins + report). Nav `Aggiornamenti`/`Compatibilità` in sidebar.
- Verificato nel preview: flusso delta end-to-end (4 modifiche → commit gated) e report compatibilità (runtime 1.6.1170.0, SKSE 2.2.6 compatibile). `tsc` 0 errori, `vite build` OK, **116 test** verdi.

### Added — Launch pre-flight: dati reali (T3 + T5)
- **T3** `electron/steam/mo2.ts`: risoluzione profilo MO2 attivo **portable + instance-mode** (`%LOCALAPPDATA%/ModOrganizer/<istanza>` via `CurrentInstance`), parser `selected_profile`/`profiles_directory`/`@ByteArray`, override path assoluto, fallback per mtime del `plugins.txt`, guard path-traversal, letture BOM-tolerant. `VerifyLoadOrder` ora valuta il vero `plugins.txt`. +11 test. Review avversariale MO2 (instance-mode) applicata.
- **T5** `electron/steam/version.ts` + `detectSkse()` in `detect.ts`: versione runtime da Address Library (`version-*.bin`, multi-bin → max) e build SKSE da `skse64_<a>_<b>_<c>.dll`; `gameVersionSupported` popolato realmente (match 3 componenti, `null`=no blocco spurio). +8 test.
- Totale test **116 / 17 file** verdi.

### Build / Packaging
- **Build di produzione verificata:** `npm run build` (renderer + bundle Electron 313 KB) + `electron-builder --win --dir` → `release/win-unpacked/` con `app.asar` (53 MB) e `better_sqlite3.node` UNPACKED.
- **Smoke runtime reale** (`scripts/smoke.ts` sotto `electron.exe`): better-sqlite3 ABI Electron, migrazioni→v3, integrity_check, verifica manifest firmato con chiave reale, re-ingest idempotente → PASS.
- **Fix packaging:** `build.files` ora include `node_modules/**/*` (la whitelist precedente avrebbe escluso better-sqlite3 dall'installer); `win.signAndEditExecutable:false` per sblocco build senza certificato.
- `release/`, `dist-electron/`, `dist-smoke/` aggiunti a `.gitignore`.

### Changed — Backup hardening cablato (chiude R5)
- `electron/backup/manager.ts`: core backup electron-free (atomic write + checksum sidecar + restore che rifiuta i corrotti + snapshot whole-DB `VACUUM INTO` opzionale). `backupManager.ts` ora delega al core (thin IPC). Fix `backup:auto` (era `ipcMain.emit` rotto). Lockstep colonne delta (`nexus_file_id`/`file_hash`) provato dai test. +5 test (totale **100/15**).

### Added — Launch & Steam (Companion Mode)
- Rilevamento Steam read-only: percorso da registro, librerie da `libraryfolders.vdf`, AppID Skyrim 489830 da `appmanifest`, stato `steam.exe` (`electron/steam/{vdf,detect}.ts`).
- Workflow di avvio puro a 10 stage con gate `canLaunch` enforced nel main (`src/lib/launchWorkflow.ts`, `electron/launch/preflight.ts`).
- UI preflight a checklist: lancio abilitato solo se nessun critico fallisce (`src/components/ui/LaunchPreflight.tsx`).
- IPC `steam:detect` / `launch:preflight` / `launch:run` + mock browser.
- Doc `docs/LAUNCH-WORKFLOW.md`.

### Added — Nexus (Deferred Activation)
- Provider astratto + `MockNexusProvider` + `HttpNexusProvider` disabled-safe (`electron/nexus/*`).
- Cache SQLite TTL + ETag + retry/backoff su 429 + offline fallback.
- Factory `.env`-driven (`NEXUS_ENABLED`/`NEXUS_API_KEY`) → mock finché senza chiave.
- Catalogo persistente esteso (`nexus_*`, `source`, `sha256`, …) via migrazione v3.
- `.env.example`, doc `docs/NEXUS-INTEGRATION.md`.

### Added — Compatibilità
- Analizzatore modlist puro: classificazione ESL/ESP/ESM, limite load-order 254, SKSE/Address Library, version drift, parser `plugins.txt`/`loadorder.txt`, advisory xEdit (`src/lib/compatibility.ts`).

### Added — Delta Update v2 (GO)
- Manifest firmato Ed25519 + verifica (allowlist host, anti-replay) fail-closed (`electron/delta/{manifest,canonicalJson,pinnedKey}.ts`).
- DeltaService electron-free (ingest→verify→stage→commit→recovery) + engine IPC sottile (`electron/delta/{service,engine,hooks}.ts`).
- Journal persistente + commit gated single-source-of-truth + recovery (`electron/delta/journal.ts`).
- Diff changeset + comparatore versioni tollerante (`electron/delta/{diff,version}.ts`).
- Migration framework `user_version` (1 baseline, 2 delta-versioning, 3 nexus) (`electron/db/{sqlite,migrations}.ts`).
- Backup hardening: `VACUUM INTO`, write atomico, checksum, hash pre-extract (`electron/backup/snapshot.ts`).
- Chiave Ed25519 reale generata; manifest di esempio firmato (`electron/delta/examples/catalog.signed.json`).
- Signer CI Python (`scripts/sign_manifest.py`).
- Single-instance lock; integrity_check all'avvio; delete FK-safe.
- Doc `docs/DELTA-UPDATES-v2.md`, `docs/GO-LIVE.md`.

### Added — Testing
- Suite vitest con motore reale `node:sqlite`: **95 test / 14 file** (unit, integration, chaos, stress, recovery, e2e).

### Changed
- `mods` += `nexus_file_id`, `file_hash`; `MOD_COLUMNS` e `backupManager` BOUND allineati (lockstep).
- Pipeline install: hook delta su completamento; long-path Windows; cache archivi.
- Download manager: retry+backoff, circuit breaker, throttling progress.

### Security
- Cifratura Nexus API key a riposo (safeStorage); CSP + navigation hardening; SQL column whitelist; manifest trust boundary.

## [1.0.0] — Base
- App Electron+React+TS+SQLite: dashboard, lista mod, catalogo (103 mod), download, conflitti, plugin, strumenti, profili, statistiche, backup, documentazione; preview browser via mock.
