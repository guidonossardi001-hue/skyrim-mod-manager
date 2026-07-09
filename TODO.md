# TODO — Debito tecnico & azioni aperte

> Lista azionabile. Ogni voce: contesto, azione, file, criticità. Niente è bloccante per la build (vedi GO_NO_GO.md).

## 🔴 Alta priorità (attivazione produzione)
### T1 — Attivare Nexus reale  *(parz. sbloccato 2026-06-25)*
- **Contesto:** provider HTTP implementato e disabled-safe; oggi gira il mock. **Fatto:** toggle in-app `nexusEnabled` (Impostazioni) + gating `main.ts` su env **oppure** setting; chiave cifrata già iniettata in provider + `download_link`.
- **Azione residua (utente):** incollare la **API key Premium** in Impostazioni → Nexus, premere **Verifica**, attivare il toggle. Poi verificare `getMod`/`getFiles`/`checkUpdate` reali + cache ETag/429 contro l'API vera.
- **File:** `electron/nexus/httpProvider.ts`, `electron/main.ts` (handler `nexus:*`), `src/components/pages/Settings.tsx`.

### Stock-UI — Pannello StockGame nel renderer
- **Contesto:** backend StockGame completo (modulo + IPC `stockgame:detect|create` + evento progresso + `window.api.stockGame`), ma **manca la UI** che mostri sorgente/target/peso-stimato e lanci la build con barra di avanzamento.
- **Azione:** sezione in Impostazioni o Dashboard: `stockGame.detect()` per anteprima (file/byte vanilla, byte mod saltati), bottone "Crea StockGame", listener `stockgame:progress`, scelta hardlink/copy.

### ~~E2E-DL — Test download reale end-to-end~~ → ✅ FATTO (2026-06-25)
- **Superato con Premium reale:** `4k Farmhouse Fences SE` (38912/153295, 50 MB) → link CDN (`cf-files.nexusmods.com`) → download → **md5 ✓** vs backup → `7z t` ✓ → **8 file estratti** (96,3 MB) in `data/StockGame/mods/`. Harness `scripts/e2e_download.mjs` riusabile.
- **Residuo prima della cancellazione di massa:** validare a **scala** (batch di 5–10 mod con formati misti .zip/.7z/.rar e un file grande >1 GB) prima di eliminare i 329 GB della cartella Vortex. La singola mod è provata; il batch no.

### ~~E2E-BATCH — Validazione a scala~~ → ✅ FATTO (2026-06-25)
- **4/4 superato:** `.7z`/`.zip`/`.rar` + file **1,01 GB**, concorrenza 3, **resume self-test** (caduta→Range→integro), tutti md5 ✓ + `7z t` ✓. Harness `scripts/e2e_batch.mjs`. Fix overflow `content-range` su >2 GB.
- **Verdetto cancellazione Vortex:** la pipeline è ora **blindata** (formati misti, file pesante, concorrenza, resume, integrità md5). Con il `vortex-collections-backup.json` come rete + tutto ri-scaricabile, **eliminare `…\Vortex\skyrimse\mods` è ragionevolmente sicuro**. Prudenza extra suggerita: prima del wipe totale, lanciare un batch un po' più ampio (es. 15–20 mod misti) per confidenza statistica.

### ~~Cabl-01 — Cablare il flusso reale nella Dashboard~~ → ✅ FATTO (2026-06-25)
- Orchestratore `electron/sync/massSync.ts` (resolve→download resumibile→md5 vs backup→estrai, concorrente, idempotente, cancellabile, **isolamento StockGame fail-closed**) + IPC `sync:start|cancel|status` + `window.api.sync`. Bottone "Sincronizza e Avvia" → conferma scale-aware + barra live `sync:progress`. 9 test.
- **Residuo (utente):** il run reale dei 329 GB parte solo cliccando il bottone nell'**app desktop** (non nel preview browser) con Nexus abilitato. Eventuale step finale: cablare anche la creazione StockGame come pre-fase del sync + lancio Pandora/launch post-sync.

### ~~Precheck-01 — Pre-flight disco aggregato~~ → ✅ FATTO (2026-06-26)
- `massSync.ts`: `pendingBytes`/`computeDiskPreflight`/`diskPreflight` + enforcement bloccante fail-closed prima di ogni download; IPC `sync:preflight` + card GO/NO-GO Dashboard. +5 test.
- **Verdetto reale ADESSO: NO-GO** — 4.568 mod → richiesti **416,8 GB** (329,5 × 1.10 × 1.15) vs **276 GB liberi su C:** = margine **−140,8 GB**. Il disco è saturo da Steam (236 GB) + archivi Vortex (329 GB). **Dipendenza**: liberare spazio (es. eliminare Vortex, ma è ciò che stiamo gating) o puntare lo StockGame su un volume ≥417 GB liberi.

### Run-Prog — Run reale progressivo (prossimo passo)
- **Piano:** 100 mod → 300 mod → 500 mod → decisione finale. Misurare throughput/ETA reali, osservare 429+breaker+resume al limite API (~2500 req/giorno), confermare cleanup e isolamento a scala.
- **Bloccante prima del run completo:** risolvere lo spazio disco (pre-flight NO-GO) e scegliere il volume StockGame.

### Run-Real — Avvio grafico reale (utente)
- **Contesto:** tutto cablato; manca solo l'esecuzione reale dall'app desktop (e lo spazio disco).
- **Azione:** `.\start.ps1 electron` → Dashboard → (opz.) crea StockGame → "Sincronizza e Avvia" → osservare barra live + card pre-flight.

### ~~T2 — Manifest catalogo remoto firmato~~ → ✅ FATTO (2026-06-24)
- Catalogo reale firmato `electron/delta/examples/catalog.remote.signed.json` (release `2026.06-core`, counter 2, 6 mod con `version`/`file_id`/`file_hash` sha256 reale/host Nexus). Producer `scripts/build_remote_catalog.mjs` (parità Node del signer Python — stesso `canonicalJSON`+Ed25519, firma verificata dalla chiave pinnata). Cablato nella pagina Aggiornamenti. Test `electron/delta/remoteCatalog.test.ts` (4: verifica pinnata, schema, anti-tamper, ingest+drift).
- **Residuo:** è un artefatto **bundlato** (non ancora servito via HTTP da un host reale) e i `file_hash` sono sha256 di un descrittore deterministico finché non si dispone degli archivi reali. Il fetch su rete reale resta Act-03.

## 🟠 Media priorità (debito tecnico)
### ~~T3 — Parsing reale plugins.txt~~ → ✅ FATTO (2026-06-23)
- `electron/steam/mo2.ts`: risoluzione **portable + instance-mode** (`%LOCALAPPDATA%/ModOrganizer/<istanza>`), `selected_profile`/`@ByteArray`, override `profiles_directory` (assoluto/relativo/`%BASE_DIR%`), fallback per mtime del `plugins.txt`, guard path-traversal, letture BOM-tolerant. Cablato in `buildLaunchEnv` → `VerifyLoadOrder` valuta il vero plugins.txt. Review avversariale MO2 applicata. Test: `electron/steam/mo2.test.ts` (11).

### ~~T4 — backupManager usa snapshot.ts~~ → ✅ FATTO (2026-06-23)
- `electron/backup/manager.ts` (core electron-free): atomic write + checksum + `backup:auto` cattura whole-DB snapshot; restore rifiuta i corrotti; lockstep colonne delta provato. `backupManager.ts` ora è un thin IPC layer. Test: `electron/backup/manager.test.ts` (5).

### ~~T5 — Versione runtime Skyrim & compatibilità SKSE~~ → ✅ FATTO (2026-06-23)
- `electron/steam/version.ts` (parse `version-1-6-1170-0.bin` + `skse64_1_6_1170.dll`, match su 3 componenti, `null`=no blocco spurio) + `detectSkse()` in `detect.ts` (multi-bin → versione più alta) cablato in `preflight` → `gameVersionSupported` popolato realmente. Test: `electron/steam/version.test.ts` (8). NB: reviewer T5 caduto per limite sessione → auto-review applicata sui casi noti (multi-bin, VR/loader esclusi dal regex, fail-safe null).

## 🟢 Fatto in questa sessione
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

### ~~Chiave API Nexus persistita nel DB (cifrata)~~ → ✅ FATTO (2026-06-24)
- Migrazione **v4** + `electron/db/secrets.ts` (tabella `app_secrets`, valore cifrato DPAPI via `safeStorage`); `settings:get/set/get-all` instradano i secret al DB con migrazione automatica dal vecchio `electron-store`. `downloadManager.getApiKey`/provider Nexus leggono dal DB → header reale `apikey`/`Bearer`. Test `secrets.test.ts` (6), smoke→v4.
- **Nota sicurezza:** il valore in `app_secrets` è SEMPRE ciphertext (mai chiaro), coerente con la regola "mai chiave in chiaro". Il file DB è in `userData` (non nel repo).

### ~~Nexus download_link + validazione 7-Zip~~ → ✅ FATTO (2026-06-24)
- `electron/nexus/downloadLink.ts`: endpoint reale con header `apikey`/`Authorization: Bearer` + nxm `key`/`expires`, errori parlanti (401/403→Premium, 404, 429); cablato in `downloadManager.resolveUrl`. `electron/install/sevenZip.ts` + IPC `tools:validate-7z` (auto-detect + validazione binario) + sezione Impostazioni (Sfoglia/Rileva/Verifica + warning). Test: `downloadLink.test.ts` (10) + `sevenZip.test.ts` (5).
- **Residuo:** download diretto reale = Nexus **Premium** (o flusso nxm:// per non-premium, non ancora gestito a livello di protocol handler). OAuth Bearer è supportato nell'header ma non c'è ancora un flusso di login OAuth.

### ~~Archivi reali — download streaming + estrazione sicura~~ → ✅ FATTO (2026-06-24)
- `electron/install/downloadStream.ts` (`.part` + resume Range, promozione atomica, integrità) e `electron/install/extract.ts` (7z streaming + progress, zip-slip guard, OOM cap adm-zip, sha256 streaming) cablati in `downloadManager`/`installManager` (verifica hash pre-estrazione, cleanup su errore). UI: stadio installazione (verifica/estrazione %) via `install:progress`. Test: `extract.test.ts` + `downloadStream.test.ts` (13).
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

## 🚢 Deployment
### D1 — Produrre l'installer NSIS
- **Contesto:** l'app è già impacchettata (`release/win-unpacked/`, better-sqlite3 unpacked); manca solo il wrapper NSIS. `electron-builder` NSIS fallisce in questo ambiente perché winCodeSign richiede la creazione di symlink (privilegio negato).
- **Azione:** sulla macchina di build abilitare **Windows Developer Mode** (Impostazioni → Privacy e sicurezza → Per sviluppatori) **o** eseguire il terminale come **Amministratore**, poi `electron-builder --win` (target `nsis`). Per release firmata: fornire certificato (`CSC_LINK`/`CSC_KEY_PASSWORD`).
- **Verificato:** `--dir` produce l'app spacchettata correttamente; smoke runtime PASS.

## Note QA
Prima di chiudere ogni sessione: `npm test` verde, `tsc` 0 errori, renderer build OK, aggiornare gli 8 documenti di stato.
