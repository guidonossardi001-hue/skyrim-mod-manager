# TODO — Debito tecnico & azioni aperte

> Lista azionabile. Ogni voce: contesto, azione, file, criticità. Niente è bloccante per la build (vedi GO_NO_GO.md).

## 🔴 Alta priorità (attivazione produzione)
### T1 — Attivare Nexus reale  *(parz. sbloccato 2026-06-25; sicurezza rinforzata 2026-07-09)*
- **Contesto:** provider HTTP implementato e disabled-safe; oggi gira il mock. **Fatto:** toggle in-app `nexusEnabled` (Impostazioni) + gating `main.ts` su env **oppure** setting; chiave cifrata già iniettata in provider + `download_link`.
- **Fatto (2026-07-09):** la chiave NON transita più in chiaro sull'IPC — `settings:get/get-all` restituiscono solo un segnaposto mascherato (`********`), gli handler `nexus:*` la leggono **esclusivamente** dal secret store del main (mai passata dal renderer). `nexus:validate-key` accetta un candidato appena digitato (non ancora salvato) senza mai esporre il valore persistito.
- **Azione residua (utente):** incollare la **API key Premium ruotata** (vedi nota sicurezza sotto) in Impostazioni → Nexus, premere **Verifica**, attivare il toggle. Poi verificare `getMod`/`getFiles`/`checkUpdate` reali + cache ETag/429 contro l'API vera.
- **File:** `electron/nexus/httpProvider.ts`, `electron/main.ts` (handler `nexus:*`), `src/components/pages/Settings.tsx`.

### ~~Stock-UI — Pannello StockGame nel renderer~~ → ✅ FATTO
- `src/components/ui/StockGamePanel.tsx`: anteprima sorgente/destinazione + peso vanilla stimato/mod scartati (`stockGame.detect()`), bottone "Crea StockGame", barra di avanzamento live su `stockgame:progress`, scelta hardlink/copy. Cablato nella Dashboard.

### ~~E2E-DL — Test download reale end-to-end~~ → ✅ FATTO (2026-06-25)
- **Superato con Premium reale:** `4k Farmhouse Fences SE` (38912/153295, 50 MB) → link CDN (`cf-files.nexusmods.com`) → download → **md5 ✓** vs backup → `7z t` ✓ → **8 file estratti** (96,3 MB) in `data/StockGame/mods/`. Harness `scripts/e2e_download.mjs` riusabile.
- **Residuo prima della cancellazione di massa:** validare a **scala** (batch di 5–10 mod con formati misti .zip/.7z/.rar e un file grande >1 GB) prima di eliminare i 329 GB della cartella Vortex. La singola mod è provata; il batch no.

### ~~E2E-BATCH — Validazione a scala~~ → ✅ FATTO (2026-06-25)
- **4/4 superato:** `.7z`/`.zip`/`.rar` + file **1,01 GB**, concorrenza 3, **resume self-test** (caduta→Range→integro), tutti md5 ✓ + `7z t` ✓. Harness `scripts/e2e_batch.mjs`. Fix overflow `content-range` su >2 GB.
- **Verdetto cancellazione Vortex:** la pipeline è ora **blindata** (formati misti, file pesante, concorrenza, resume, integrità md5). Con il `vortex-collections-backup.json` come rete + tutto ri-scaricabile, **eliminare `…\Vortex\skyrimse\mods` è ragionevolmente sicuro**. Prudenza extra suggerita: prima del wipe totale, lanciare un batch un po' più ampio (es. 15–20 mod misti) per confidenza statistica.

### ~~Cabl-01 — Cablare il flusso reale nella Dashboard~~ → ✅ FATTO (2026-06-25)
- Orchestratore `electron/sync/massSync.ts` (resolve→download resumibile→md5 vs backup→estrai, concorrente, idempotente, cancellabile, **isolamento StockGame fail-closed**) + IPC `sync:start|cancel|status` + `window.api.sync`. Bottone "Sincronizza e Avvia" → conferma scale-aware + barra live `sync:progress`. 9 test.
- **Residuo (utente):** il run reale dei 329 GB parte solo cliccando il bottone nell'**app desktop** (non nel preview browser) con Nexus abilitato. Eventuale step finale: cablare anche la creazione StockGame come pre-fase del sync + lancio Pandora/launch post-sync.

### ~~Precheck-01 — Pre-flight disco aggregato~~ → ✅ FATTO (2026-06-26; ricalcolato per blocco 2026-07-09)
- `massSync.ts`: `pendingBytes`/`computeDiskPreflight`/`diskPreflight` + enforcement bloccante fail-closed prima di ogni download; IPC `sync:preflight` + card GO/NO-GO Dashboard. +5 test.
- **Verdetto storico (2026-06-26): NO-GO** — 4.568 mod → richiesti **416,8 GB** (329,5 × 1.10 × 1.15) vs **276 GB liberi su C:** = margine **−140,8 GB**.
- **Aggiornamento (2026-07-09):** spazio libero su C: ricontrollato — ora **648,4 GB liberi** (282,1 GB usati), un salto di +372 GB rispetto al 26/06. Contro lo stesso requisito stimato (~416,8 GB per l'intera modlist), il margine tornerebbe **positivo (+231,6 GB)** → verdetto **presumibilmente GO** per l'intera lista, ma **da confermare nell'app** (la card Dashboard è la fonte di verità: il calcolo esatto dipende dal numero di mod ancora *pending* in quel momento). Con la card ora **per-blocco** (vedi Run-Prog sotto) il fabbisogno del primo blocco da 100 mod è comunque un ordine di grandezza più piccolo e quasi certamente GO anche nello scenario peggiore.

### ~~Run-Prog — Run reale progressivo~~ → ✅ IMPLEMENTATO (2026-07-09)
- **Fatto:** `sync:start` accetta `limit` e seleziona le **prossime N mod non ancora presenti** nello StockGame (progressione reale tra run successivi — non le prime N della lista, che dopo il primo run sarebbero tutte skip). `sync:preflight` valuta lo spazio del **solo blocco pianificato** quando `limit` è impostato, così la card GO/NO-GO riflette il run che sta per partire. Dashboard: campo "Blocco Run-Prog" (default **100**, 0 = intera lista), badge "blocco N/tot" sulla card pre-flight, conferma e log consapevoli del blocco.
- **File:** `electron/main.ts` (`selectSyncBlock`, handler `sync:start`/`sync:preflight`), `src/components/pages/Dashboard.tsx`, `electron/preload.ts`, `src/types/index.ts`.
- **Residuo (utente):** eseguire davvero la sequenza 100 → 300 → 500 → decisione finale, osservando throughput/ETA reali, comportamento di 429+breaker+resume al limite API (~2500 req/giorno) e cleanup a scala. Ogni click successivo su "Sincronizza e Avvia" riprende automaticamente dal punto giusto (nessuna azione manuale tra un blocco e l'altro).

### ~~Run-Real — Avvio grafico reale~~ → ✅ FATTO (2026-07-09)
- **Contesto:** tutto cablato; mancava solo l'esecuzione reale dall'app desktop.
- **Fatto:** build di produzione verificata (`tsc` + `vite build`, `dist-electron` pulita a ogni build) e **boot reale dell'app collaudato**: finestra avviata, migrazioni schema v6 applicate (inclusi gli indici), auto-detect percorsi riuscito, sorgente sync caricata (4.568 mod dal backup).
- **Avvio zero-sforzo:** `avvia_launcher.bat` in root — doppio click da Esplora Risorse: si posiziona da solo nel progetto (niente più ENOENT), ripara automaticamente un binario Electron mancante/corrotto, esegue `npm run build`, poi lancia `electron.exe` direttamente (bypassa del tutto la Execution Policy di PowerShell). Modalità rapida senza rebuild: `avvia_launcher.bat veloce`.
- **Azione utente:** doppio click su `avvia_launcher.bat` → Dashboard → verificare card pre-flight (GO) → (opz.) "Crea StockGame" → "Sincronizza e Avvia" per il primo blocco Run-Prog.

### ~~T2 — Manifest catalogo remoto firmato~~ → ✅ FATTO (2026-06-24)
- Catalogo reale firmato `electron/delta/examples/catalog.remote.signed.json` (release `2026.06-core`, counter 2, 6 mod con `version`/`file_id`/`file_hash` sha256 reale/host Nexus). Producer `scripts/build_remote_catalog.mjs` (parità Node del signer Python — stesso `canonicalJSON`+Ed25519, firma verificata dalla chiave pinnata). Cablato nella pagina Aggiornamenti. Test `electron/delta/remoteCatalog.test.ts` (4: verifica pinnata, schema, anti-tamper, ingest+drift).
- **Residuo:** è un artefatto **bundlato** (non ancora servito via HTTP da un host reale) e i `file_hash` sono sha256 di un descrittore deterministico finché non si dispone degli archivi reali. Il fetch su rete reale resta Act-03.

## 🔒 Sicurezza (hardening di produzione, 2026-07-09)
### ~~SEC-01 — Materiale crittografico fuori dal repo, sempre cifrato~~ → ✅ FATTO
- `scripts/sign_manifest.py`: la chiave privata di firma NON ha più un percorso fisso nel progetto — si risolve da `SKYRIM_RELEASE_PRIV_KEY_PATH` (o `--key`) e lo script **rifiuta** esplicitamente percorsi interni all'albero del repo. Su disco è **sempre** PKCS8 + `BestAvailableEncryption(passphrase)` (mai più `NoEncryption`); passphrase da prompt nascosto (`getpass`) o, in CI, da `SKYRIM_RELEASE_KEY_PASSPHRASE`. Nuovo comando `encrypt-key` per migrare una chiave storica in chiaro.
- `scripts/build_remote_catalog.mjs` (il secondo produttore, prima hardcodava `secrets/release_priv.pem`) allineato alla stessa risoluzione via env + supporto PEM cifrata.
- `scripts/protect_release_key.mjs` (nuovo, per macchine senza Python): migrazione one-shot — cifra, sposta fuori dal repo, e **valida il roundtrip di firma contro la chiave pubblica pinnata** prima di suggerire la cancellazione dell'originale. Eseguito con successo sulla chiave reale del progetto.
- **Azione residua (utente):** eseguire i 3 comandi di migrazione (`node scripts/protect_release_key.mjs` → `icacls` → `setx SKYRIM_RELEASE_PRIV_KEY_PATH`), poi cancellare `secrets/release_priv.pem` e `secrets/release_pub.pem` (la pubblica canonica è tracciata in `docs/keys/release_pub.pem`).

### ~~SEC-02 — `nexus.key` dismessa~~ → ✅ FATTO
- Nessun codice applicativo l'ha mai letta (l'app usa il secret store cifrato via `safeStorage`/DPAPI). Gli script di sviluppo (`exec_boot.mjs`, `sync_smoke.ts`, `sync_batch_smoke.ts`, `e2e_download.mjs`, `e2e_batch.mjs`) ora richiedono **solo** `$env:NEXUS_API_KEY`.
- **Azione residua (utente):** cancellare `secrets/nexus.key` e **ruotare la chiave** su nexusmods.com (è rimasta in chiaro su disco → va considerata esposta).

### ~~SEC-03 — API key mai esposta al renderer~~ → ✅ FATTO
- `settings:get`/`settings:get-all` restituiscono solo il segnaposto `********`; gli handler `nexus:search`/`nexus:get-mod` leggono la chiave **esclusivamente** main-side. `encryptSecret` ora è fail-closed (rifiuta di salvare se `safeStorage` non è disponibile, invece di ripiegare silenziosamente sul plaintext).

### ~~SEC-04 — Lockdown IPC (esecuzione arbitraria, canali, path traversal)~~ → ✅ FATTO
- `tools:launch-*` non accettano più un percorso `.exe` dal renderer: il main risolve l'eseguibile dal settings store (`toolPath()`); il renderer sceglie solo *quale* tool avviare. `electron/preload.ts`: whitelist esplicita dei 10 canali evento legittimi per `on()`/`off()` (prima si poteva sottoscrivere qualunque canale IPC interno); `off()` ora funziona anche passando il listener originale (non solo il wrapper). `fs:open-external` accetta solo `http(s)://`. `fs:read-dir` reso asincrono (niente più blocco del main process su directory grandi).

### ~~SEC-05 — `.gitignore` blindato + primo repository Git~~ → ✅ FATTO
- Il progetto **non era un repository Git** (rischio di versionamento nullo, segnalato in RISK_MATRIX R9) — ora inizializzato (`git init -b main`) con **4 commit** puliti. `.gitignore` esclude `secrets/*` (tranne il README di bonifica), `*.pem` (tranne `docs/keys/release_pub.pem`), `*.key`, `.env*`, i database locali (`*.db*`, `*.sqlite*`), `node_modules/`, `dist*/`, `release/`, `data/` (30+ GB di cache/StockGame). Verificato con `git check-ignore` su ogni segreto **prima** del primo commit; audit dei file in staging confermato senza materiale sensibile.

## ⚙️ Qualità del codice (2026-07-09)
### ~~QUAL-01 — ESLint 9 + Prettier + CI~~ → ✅ FATTO
- `eslint.config.js` (flat config): recommended JS + TypeScript + React Hooks, baseline pragmatica (violazioni di solo stile → warning, non bloccanti). `.prettierrc.json` calibrato sullo stile esistente. Script npm: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`. Durante la calibrazione il lint ha scovato **3 bug latenti reali** (un `require()` CommonJS fragile in `electron/steam/detect.ts`, caratteri BOM letterali invisibili nei regex di `electron/steam/mo2.ts`, un escape regex errato in `scripts/exec_boot.mjs`) — tutti corretti.
- `.github/workflows/ci.yml`: pipeline GitHub Actions su `windows-latest` (coerente con la piattaforma target: `better-sqlite3` nativo + 7-Zip bundled), tre step lint → typecheck → test (266 test vitest) a ogni push/PR.
- **Stato attuale:** 0 errori ESLint, 26 warning informativi (da stringere in futuro), `tsc --noEmit` pulito, 266/266 test verdi.

## 📈 Performance & refactor funzionale/reattivo (2026-07-09)
### ~~PERF-01 — Indici SQLite + throttling scritture~~ → ✅ FATTO
- Migrazione **v6**: indici su `mods(profile_id)`, `mods(nexus_id)`, `downloads(profile_id)`, `downloads(status)`, `downloads(mod_id)`, `delta_changeset(download_id)` — prima ogni query calda (liste mod/download, resume, callback delta) faceva full scan. Persistenza del progresso download throttlata a 1 scrittura/secondo per download (prima: una scrittura WAL per ogni tick da 250ms, fino a ~32/s con 8 download concorrenti).

### ~~PERF-02 — Virtualizzazione completa + selettori Zustand shallow~~ → ✅ FATTO
- `ModList.tsx`: **tutte e tre le viste** ora virtualizzate con `react-virtuoso` (prima solo il ramo filtrato/ordinato lo era — la vista di default, riordinabile via drag&drop, montava ~70.000 nodi DOM alla scala target di ~4.500 mod). Righe `React.memo` con handler stabili condivisi via `useMemo`, lookup conflitti O(1) (era `Array.find` per riga per render).
- `Downloads.tsx`: `DownloadRow` memoizzata (un evento di progresso ora aggiorna solo la riga interessata, non l'intera pagina — prima ~16 re-render/s dell'intera lista con 4 download attivi).
- Selettori `useShallow` sui componenti sempre montati (`App`, `Sidebar`, `TitleBar`) — prima ogni `set()` dello store (incluse le righe di log) ri-renderizzava l'intero albero.

### ~~PERF-03 — Batch IPC, cancellazione stale, error handling~~ → ✅ FATTO
- `appStore.ts`: guard di staleness (token incrementale) su `loadMods`/`loadDownloads` — la risposta IPC di un profilo vecchio, se arriva dopo un cambio profilo rapido, viene ora scartata invece di sovrascrivere i dati nuovi. Check aggiornamenti Nexus con pool a concorrenza 4 + un solo `set()` finale (prima: loop seriale, 15-40 minuti a 4.500 mod + un re-render globale per mod). Import MO2 in un solo batch IPC/transazione (`mods:add-many`, nuovo handler) invece di un round-trip per riga.
- `App.tsx` bootstrap con `try/finally` (un errore di init non lascia più l'app bloccata sull'overlay "Inizializzazione…"); handler globali `uncaughtException`/`unhandledRejection` nel main; mock backend caricato **solo in DEV** (in produzione un preload rotto ora fallisce visibilmente invece di ripiegare silenziosamente su dati simulati).

### ~~PERF-04 — Robustezza pipeline download/installer~~ → ✅ FATTO
- `downloadStream.ts`: gestito il caso 416 (`.part` già completo dopo un crash pre-promozione — prima restava bloccato per sempre, essendo un 4xx non ritentabile). `downloadManager.ts`: cache-hit ora validato sulla dimensione attesa (prima si fidava di qualsiasi file omonimo con size>0); nomi archivio includono il `file_id` Nexus (niente più collisioni tra file diversi della stessa mod); il task viene registrato **prima** degli `await` di rete (fix race sul limite di concorrenza + pause/cancel "fantasma" durante la risoluzione del link). `installManager.ts`: il cleanup su errore non cancella più una installazione preesistente in caso di reinstallazione fallita.

## 🚀 Produzione (2026-07-09)
### ~~PROD-01 — Icona placeholder per il packaging~~ → ✅ FATTO
- `resources/icons/icon.ico` era referenziata (`package.json` build config, `electron/main.ts`) ma **inesistente** — `electron-builder` sarebbe fallito al primo build dell'installer. Generata via `scripts/make_placeholder_icon.mjs` (zero dipendenze, PNG 256×256 + container ICO scritti a mano). Rigenerabile con `npm run icon:placeholder`; da sostituire con l'icona definitiva quando disponibile (stesso percorso).

### ~~PROD-02 — Igiene build/packaging~~ → ✅ FATTO
- `vite.config.ts`: `emptyOutDir: true` sul build del main process (prima `dist-electron/` accumulava ~50 bundle hashati stale tra una build e l'altra, tutti spediti nell'installer). `package.json` build.files: rimosso `node_modules/**/*` ridondante (electron-builder colleziona già le sole dipendenze di produzione). `electron/logger.ts`: rotazione del log a 5 MB (prima cresceva senza limite). Corretto un bug reale: il pulsante Pandora in `Tools.tsx` chiamava `launchMO2` invece di `launchPandora`.

## 🟠 Media priorità (debito tecnico)
### ~~T3 — Parsing reale plugins.txt~~ → ✅ FATTO (2026-06-23)
- `electron/steam/mo2.ts`: risoluzione **portable + instance-mode** (`%LOCALAPPDATA%/ModOrganizer/<istanza>`), `selected_profile`/`@ByteArray`, override `profiles_directory` (assoluto/relativo/`%BASE_DIR%`), fallback per mtime del `plugins.txt`, guard path-traversal, letture BOM-tolerant. Cablato in `buildLaunchEnv` → `VerifyLoadOrder` valuta il vero plugins.txt. Review avversariale MO2 applicata. Test: `electron/steam/mo2.test.ts` (11).

### ~~T4 — backupManager usa snapshot.ts~~ → ✅ FATTO (2026-06-23)
- `electron/backup/manager.ts` (core electron-free): atomic write + checksum + `backup:auto` cattura whole-DB snapshot; restore rifiuta i corrotti; lockstep colonne delta provato. `backupManager.ts` ora è un thin IPC layer. Test: `electron/backup/manager.test.ts` (5).

### ~~T5 — Versione runtime Skyrim & compatibilità SKSE~~ → ✅ FATTO (2026-06-23)
- `electron/steam/version.ts` (parse `version-1-6-1170-0.bin` + `skse64_1_6_1170.dll`, match su 3 componenti, `null`=no blocco spurio) + `detectSkse()` in `detect.ts` (multi-bin → versione più alta) cablato in `preflight` → `gameVersionSupported` popolato realmente. Test: `electron/steam/version.test.ts` (8). NB: reviewer T5 caduto per limite sessione → auto-review applicata sui casi noti (multi-bin, VR/loader esclusi dal regex, fail-safe null).

## 🟢 Fatto in sessioni precedenti
### ~~Foundation Nolvus Ascension nel catalogo ("il necessario")~~ → ✅ FATTO (2026-06-25)
- +12 framework/SKSE-plugin base dalla guida ufficiale Nolvus Ascension (ID Nexus reali verificati). Sono le dipendenze richieste dalle mod di contenuto (script libs/distributori/hook). Esclusi i grafici (ENB Helper/Upscaler) come da vincolo. Catalogo 115→127 voci; peso invariato (foundation = pochi MB).
- **Riconferma:** il peso non sta nella foundation né nei contenuti non-grafici; i 300 GB sono texture (escluse).

### ~~Catalogo esteso: mod non-grafiche reali + ID corretti~~ → ✅ FATTO (2026-06-25)
- +12 mod reali verificate su nexusmods.com (quest/nuove-terre/audio/combat/survival), 103→115 voci, +10.8 GB (35.4 GB tot). Corretti 6 ID Nexus errati (link download reali). ID verificati via WebSearch (memoria spesso sbagliata).
- **Limite onesto (NON aggirabile):** i 300 GB sono ~tutti texture/grafica, categoria esclusa. I contenuti non-grafici restano nell'ordine delle decine di GB. Per altre voci serve verificare altri ID reali (posso continuare su richiesta).
- **Residuo pre-esistente (non introdotto ora):** 3 `nexus_id` duplicati nel catalogo originale [1137, 45720, 18975] — da bonificare separatamente.

### ~~Dashboard "Sincronizza e Avvia" (counter, gauge 300 GB, console, opt-in)~~ → ✅ FATTO (2026-06-25)
- `Dashboard.tsx`: hero panel con counter animato mod uniche + `DiskGauge` SVG (occupato/300 GB) + bottone centrale Nolvus-style (pipeline solo dopo clic) + toggle opt-in zero-clic con `window.confirm`; `LogConsole` scorrevole in fondo (auto-scroll, color-coded). Store: `activityLog`/`pushLog`/`clearLog`/`vortexStats`/`loadVortexStats`; `settings.autoSyncOnLaunch`; scan `totalBytes`. Verificato nel preview (833 / 288 GB / 13 righe log).
- **Nota:** l'opt-in zero-clic è l'unica via per l'avvio automatico della pipeline distruttiva, e richiede conferma esplicita all'attivazione (consenso una-tantum) — coerente con la safety approvata.

### ~~Importer Vortex + automazione gated all'avvio~~ → ✅ FATTO (2026-06-24)
- `electron/vortex/scan.ts`: scan read-only `collection.json` (modId/fileId/md5/size/optional) + nomi cartella, de-dup, build catalog (flag risorse base). Scan auto all'avvio (read-only), IPC `vortex:scan`/`build-catalog`, Pandora one-click gated (`tools:launch-pandora`). UI Strumenti. Test `scan.test.ts` (9). Validato sui dati reali (833 uniche / 2 collezioni).
- **Deviazioni motivate:** (1) richiesto in **C#** → fatto in **TS** (C# = codice morto nello stack Electron). (2) `__vortex_meta.json` **non esiste** in questa install → fonte reale = `collection.json` + nomi cartella. (3) **niente** download+estrazione+Pandora silenziosi a ogni avvio (distruttivo/irreversibile) → pipeline distruttiva dietro consenso one-click; solo lo scan è automatico.
- **Residuo:** il "one-click full pipeline" attuale fa scan→catalog→(Pandora gated). Il download di massa delle 833 mod richiede Nexus Premium e le mod sono già in Vortex; l'apply reale end-to-end è coperto da Arc-01/Act-03 ma non esercitato su questo set senza credenziali.

### ~~Sezione "Licenze di terze parti" (conformità LGPL/unRAR)~~ → ✅ FATTO (2026-06-24)
- `src/data/licenses.ts` (licenza 7-Zip integrale come stringa-asset + elenco componenti); UI Impostazioni con chip + scroll view (`<pre>` max-h/overflow); licenza anche in `resources/7zip-full/7-Zip-License.txt`. Test `licenses.test.ts` (guardia conformità). Verificato scrollabile nel preview.
- **Nota:** testo allineato alla versione 7-Zip **26.01** effettivamente bundlata (il file fornito riportava 1999-2021, termini identici; differiva solo l'anno di copyright).

### ~~.rar nativo: 7-Zip sistema primario + full 7z bundlato fallback~~ → ✅ FATTO (2026-06-24)
- `resolveRar7z()`: `detect7zPath` (sistema) primario → full 7z bundlato (`resources/7zip-full/`, asar-unpacked via `extraResources`, Rar/Rar5 verificato) fallback → notifica. `extract.ts` `full7zPath` vs `bundled7zaPath`. Settings: override opzionale. Test resolver + codec Rar reale.
- **Residuo cross-platform:** il full 7z bundlato è il binario **Windows**; su mac/linux i `.rar` ricadono su `detect7zPath` (p7zip-full di sistema) o notifica. Coerente col focus Windows del progetto. Niente test di estrazione `.rar` reale (manca un encoder rar per creare il fixture) → verificata la presenza del codec nel binario.

### ~~Estrazione nativa .7z/.zip senza configurazione~~ → ✅ FATTO (2026-06-24)
- `7zip-bin` bundlato (prebuilt, **niente C++** — rispetta il vincolo di progetto) → `.7z`/`.zip` multi-GB estratti out-of-the-box in **child process** (off-UI) con progress `-bsp1`. `extract.ts` format-aware; `.rar` via 7-Zip completo di sistema (lo standalone 7za non ha il codec Rar, verificato). Settings: 7-Zip opzionale. Test `extractNative.test.ts` (e2e reale) + `sevenZip.test.ts`.
- **Residuo `.rar`:** richiede ancora il 7-Zip **completo** installato (auto-rilevato). Alternativa non adottata: unrar WASM → carica in RAM, inadatto al multi-GB. Da valutare solo se i `.rar` diventano frequenti.

### ~~Reverse-eng. API Nolvus + pre-flight spazio disco~~ → ✅ FATTO (2026-06-24)
- Analizzato `Vcc.Nolvus.Api.Installer.dll` → `docs/NOLVUS-API-REFERENCE.md` (API proprietaria auth-gated → **non integrata**). Applicato `electron/install/diskSpace.ts` (stima ingombro estrazione + `fs.statfs`, fail-open) cablato in `installManager` prima dell'unpack. Test `diskSpace.test.ts` (8).
- **Spunto futuro (non fatto):** pre-flight requisiti hardware (GPU/VRAM/RAM vs soglie modlist) come estensione di Compatibilità — richiede dati requisiti nel catalogo (oggi assenti).

### ~~Protocol handler nxm:// (Premium + non-Premium)~~ → ✅ FATTO (2026-06-24)
- `electron/nexus/nxm.ts` (parse/find/createNxmDownload) + migrazione **v5** (`downloads.nxm_key/nxm_expires`); `main.ts` `setAsDefaultProtocolClient('nxm')` + single-instance rigoroso (seconda istanza → argv → primaria accoda) + cold-start + `open-url` (macOS) + `protocols` in electron-builder. `resolveUrl` inoltra key/expires; renderer naviga su `nxm:queued`. Test `nxm.test.ts` (8).
- **Residuo:** registrazione di sistema effettiva avviene a runtime (HKCU) o all'install (NSIS `protocols`); il flusso completo va provato con un vero click nxm dal browser + account Nexus reale. Il flusso Premium (download diretto) e non-Premium (key/expires) sono entrambi cablati ma non esercitati end-to-end senza credenziali reali.

### ~~Chiave API Nexus persistita nel DB (cifrata)~~ → ✅ FATTO (2026-06-24; irrobustito 2026-07-09, vedi SEC-03)
- Migrazione **v4** + `electron/db/secrets.ts` (tabella `app_secrets`, valore cifrato DPAPI via `safeStorage`); `settings:get/set/get-all` instradano i secret al DB con migrazione automatica dal vecchio `electron-store`. `downloadManager.getApiKey`/provider Nexus leggono dal DB → header reale `apikey`/`Bearer`. Test `secrets.test.ts` (6), smoke→v4.
- **Nota sicurezza:** il valore in `app_secrets` è SEMPRE ciphertext (mai chiaro), coerente con la regola "mai chiave in chiaro". Il file DB è in `userData` (non nel repo).

### ~~Nexus download_link + validazione 7-Zip~~ → ✅ FATTO (2026-06-24)
- `electron/nexus/downloadLink.ts`: endpoint reale con header `apikey`/`Authorization: Bearer` + nxm `key`/`expires`, errori parlanti (401/403→Premium, 404, 429); cablato in `downloadManager.resolveUrl`. `electron/install/sevenZip.ts` + IPC `tools:validate-7z` (auto-detect + validazione binario) + sezione Impostazioni (Sfoglia/Rileva/Verifica + warning). Test: `downloadLink.test.ts` (10) + `sevenZip.test.ts` (5).
- **Residuo:** download diretto reale = Nexus **Premium** (o flusso nxm:// per non-premium, non ancora gestito a livello di protocol handler). OAuth Bearer è supportato nell'header ma non c'è ancora un flusso di login OAuth.

### ~~Archivi reali — download streaming + estrazione sicura~~ → ✅ FATTO (2026-06-24; irrobustito 2026-07-09, vedi PERF-04)
- `electron/install/downloadStream.ts` (`.part` + resume Range, promozione atomica, integrità) e `electron/install/extract.ts` (7z streaming + progress, zip-slip guard, OOM cap adm-zip, sha256 streaming) cablati in `downloadManager`/`installManager` (verifica hash pre-estrazione, cleanup su errore). UI: stadio installazione (verifica/estrazione %) via `install:progress`. Test: `extract.test.ts` + `downloadStream.test.ts` (13, +2 per il caso 416).
- **Residuo:** il download REALE end-to-end richiede una chiave Nexus Premium (link `download_link.json`) non disponibile in questo ambiente → provato l'intero stack (resume/integrità/estrazione/hash) con server HTTP e archivi reali in test, ma non un vero scaricamento multi-GB da Nexus. L'estrazione `.7z`/`.rar` richiede `7z.exe` configurato (path in Impostazioni).

### ~~Act-03 — Fetch HTTP reale del catalogo + verifica firma~~ → ✅ FATTO (2026-06-24)
- `electron/delta/fetchCatalog.ts` (SSRF-safe: `new URL`+host allow-list, solo HTTPS, no-redirect, size cap, timeout) → IPC `delta:ingest-url` (fetch → trust boundary `ingest`). Campo Impostazioni `catalogUrl`; pagina Aggiornamenti usa fetch HTTPS se impostato. Test e2e con **server HTTP reale** `electron/delta/fetchCatalog.test.ts` (7: socket reale + verify + ingest; host/protocollo/oversize/redirect rifiutati; tamper→firma blocca).
- **Residuo:** in produzione serve un host reale che pubblichi `catalog.remote.signed.json` su HTTPS (oggi `NOLVUS_CATALOG_HOSTS` default = GitHub). Il download e l'apply degli **archivi** multi-GB su rete reale resta da provare end-to-end con file veri.

### ~~Delta non applicati~~ → ✅ FATTO (2026-06-24)
- Causa: `installed_snapshot` scritto solo da `finalizeApply` → nessun baseline per modlist installate normalmente. Soluzione: `electron/delta/snapshot.ts` (`syncInstalledSnapshot`) semina/riconcilia il baseline dalle mod installate (preserva `release_id`); `DeltaService.checkUpdates` diffa baseline vs ultimo manifest firmato; `store.checkAllUpdates` cablato al motore (fallback Nexus solo senza release). IPC `delta:sync-snapshot`/`delta:check-updates`. Test: `electron/delta/snapshot.test.ts` (6).
- **Residuo:** il manifest reale resta quello d'esempio finché non si pubblica il catalogo remoto firmato (T2). Mod senza `nexus_id` (alcuni import Wabbajack) non sono tracciabili nello snapshot per design.

### ~~Blocco 6 — Esporre i motori nella UI~~ → ✅ FATTO (2026-06-23)
- **Aggiornamenti** (`Updates.tsx`) sul motore delta (`window.api.delta.*`): stepper firma→delta→download→commit, changeset, apply+finalize gated.
- **Compatibilità** (`Compatibility.tsx`) su nuovo IPC `compat:analyze` (`electron/launch/compat.ts`): runtime Skyrim/SKSE (T5) + report `plugins.txt` MO2 (T3), classificazione ESM/ESP/ESL, budget 254, version drift.
- Mock browser `delta`+`compat` allineato all'IPC reale; `derivePluginsFromMods` estratta in `src/lib/plugins.ts`. Verificato nel preview; `tsc`/`vite build` OK, 116 test verdi.
- **Residuo:** la pagina Aggiornamenti in Electron ingerisce il manifest firmato d'esempio (bundle); l'aggancio al catalogo remoto reale resta T2.

## 🔵 Bassa priorità (miglioramenti)
- **T6** — Nexus search-by-name lato catalogo locale (l'API pubblica non espone search). `electron/nexus/httpProvider.ts`.
- ~~**T7** — Hash pre-estrazione cablato nell'install pipeline~~ → ✅ FATTO (2026-06-24): `electron/install/extract.ts` (`verifyArchiveHash` sha256 streaming) cablato in `installManager` da `delta_changeset.to_file_hash`. **NB:** i `file_hash` del catalogo d'esempio sono sintetici → un download REALE (chiave Nexus) verrebbe rifiutato finché non si pubblica un catalogo con hash di archivi veri (atteso, corretto: meglio fail-closed che estrarre non verificato).
- **T8** — Endpoint `nexus:search` legacy (`/Core/Libs/.../ModList`) deprecato → rimuovere o rifare. `electron/main.ts`.
- **T9** — Coverage: alzare verso 95%+ includendo i wrapper electron (oggi testato il core puro/DB; le sonde sono machine-dependent).
- **T10** — `launchGame` rimosso; verificare che nessun import morto resti (`toast` in Dashboard se inutilizzato).
- **T11** — Backup incrementali + compressione (Fase 6).
- **T12** *(nuovo 2026-07-09)* — 26 warning ESLint residui (per lo più `react-hooks/exhaustive-deps` e qualche `no-unused-vars` in pagine minori: `Docs.tsx`, `Stats.tsx`, `StockGamePanel.tsx`, `Toast.tsx`). Nessuno bloccante; da stringere quando si toccano quei file.
- **T13** *(nuovo 2026-07-09)* — 3 `nexus_id` duplicati residui nel `secrets/release_pub.pem` vs `docs/keys/release_pub.pem`: confermate byte-identiche, la copia in `secrets/` è ridondante e va rimossa insieme a `release_priv.pem` (vedi SEC-01).

## 🚢 Deployment
### D1 — Produrre l'installer NSIS
- **Contesto:** l'app è già impacchettata (`release/win-unpacked/`, better-sqlite3 unpacked); manca solo il wrapper NSIS. `electron-builder` NSIS fallisce in questo ambiente perché winCodeSign richiede la creazione di symlink (privilegio negato).
- **Fatto (2026-07-09):** l'icona placeholder che avrebbe fatto fallire il build ora esiste (vedi PROD-01) — questo blocco è rimosso dal percorso critico.
- **Azione:** sulla macchina di build abilitare **Windows Developer Mode** (Impostazioni → Privacy e sicurezza → Per sviluppatori) **o** eseguire il terminale come **Amministratore**, poi `electron-builder --win` (target `nsis`). Per release firmata: fornire certificato (`CSC_LINK`/`CSC_KEY_PASSWORD`); oggi `signAndEditExecutable: false` → installer non firmato (SmartScreen segnalerà l'app).
- **Verificato:** `--dir` produce l'app spacchettata correttamente; smoke runtime PASS. Boot reale via `avvia_launcher.bat` confermato il 2026-07-09.

## Note QA
Prima di chiudere ogni sessione: `npm test` verde, `npm run lint` (0 errori), `npm run typecheck` (0 errori), `npm run build` OK, aggiornare gli 8 documenti di stato. Da CI (GitHub Actions, `windows-latest`): stessa sequenza lint→typecheck→test ad ogni push/PR — vedi `.github/workflows/ci.yml`.
