# SESSION_STATE

> Snapshot vivo dello stato del progetto. Aggiornare a fine di ogni sessione di lavoro.
> Ultimo aggiornamento: **2026-07-16** · Stato: **installer avanzato, in uso reale** (collezione da 1739 mod importata e installata).
> Ultimo intervento: **FOMOD-01 — installer FOMOD headless col motore ufficiale Vortex + scelte del curatore della collection.** `@nexusmods/fomod-installer-native` (stesso engine XmlScriptExecutor di Vortex, N-API stabile, prebuild .NET AOT, niente rebuild per Electron) applica le mod con installer multi-scelta (1K/2K, varianti corpo, patch opzionali) estratte "piatte" nel loro layout finale, usando le scelte REALI del curatore lette dal `collection.json` dentro l'archivio della revision (non esposte dal GraphQL). IPC `fomod:fetch-choices`/`fomod:scan`/`fomod:apply-all`, card in Strumenti, Pandora ora lanciato headless (`--auto_run --auto_close`).

## 0. Cambio di rotta architetturale (2026-07-15/16) — leggere prima di tutto il resto

Le sezioni sotto (specialmente §3 "Sottosistemi") descrivono ancora, in parte, l'architettura **storica** (Mod Organizer 2 come target di lancio primario, catalogo seedato da un bundle statico + backup Vortex locale, deploy solo su un'istanza isolata). Quella architettura **non è più quella in uso**. I fatti correnti:

- **Avvio: SOLO SKSE interno.** MO2 è stato rimosso dal registry dei bootstrapper (`electron/launch/bootstrapper.ts`, `DEFAULT_BOOTSTRAPPERS = [skseBootstrapper, dragonLoaderBootstrapper]`). Il launcher stesso è il mod manager: non serve e non è supportato un secondo tool.
- **Deploy: sulla Data REALE del gioco**, non solo su un'istanza isolata. `deployTarget` in config (default `'game'`) fa puntare l'hardlink direttamente a `<gioco>/Data`, con backup `.smm-vanilla.bak` dei file preesistenti e purge che li ripristina — "torna vanilla" è un click reale, non solo su un clone.
- **Catalogo: niente più auto-seed né backup Vortex.** La `useEffect` che ri-seminava un bundle curato (~122 mod, `nexus_id` storicamente sbagliati) ad ogni mount della pagina Catalogo è stata **rimossa** (era la causa di una regressione ricorrente: il catalogo si "resuscitava" da solo dopo ogni wipe). Il file `data/vortex-collections-backup.json` (storico Vortex, 4568 mod) è stato **eliminato su richiesta esplicita dell'utente**, nessuna copia esiste più. Le uniche fonti valide per popolare il catalogo oggi sono azioni esplicite: **"Importa Collection Nexus"** (GraphQL v2 ufficiale, `modId`/`fileId` autoritativi dalla fonte) o **"Aggiorna catalogo"** (manifest firmato remoto).
- **Load order: motore interno, non LOOT esterno.** Legge i master REALI dall'header TES4 di ogni plugin (`electron/plugins/espParser.ts`) + una masterlist LOOT community reale scaricata in cache locale (`electron/plugins/lootMasterlist.ts`, fetch esplicito da `loot/skyrimse`, mai automatico) per regole "after" e rank di gruppo. Blocca il deploy PRIMA di scrivere su ciclo di dipendenze, master mancanti, o sforamento del budget 254 slot plugin "full".
- **Conflitti file: chirurgici, mai "disattiva la mod".** `deploy:preview` (dry-run, zero scritture) mostra ogni sovrascrittura reale; `deploy:prefer` alza il `resolution_weight` della mod scelta perché vinca al prossimo deploy — persistente, reversibile, mai una disabilitazione.
- **FOMOD: motore ufficiale Vortex integrato** (v. sopra) per le mod con installer multi-scelta.
- **ENB: gestore reale** (scan mod estratte + apply/remove nella root del gioco con backup) — sostituisce un vecchio pannello che mostrava dati finti (mai collegato a nulla).
- **Crash: analizzatore + auto-watch.** Dopo un GIOCA riuscito il main sorveglia i crash log SKSE e notifica da solo col modulo probabile colpevole.
- **Spazio disco: l'archivio si elimina a install riuscita** (default; `keepArchives=true` per la cache stile Nolvus). La dimensione "compressa" indicata da Nexus per una collezione è sempre molto minore dell'ingombro reale su disco (estratto + eventuale cache).

Per i dettagli implementativi di ognuno di questi punti vedi CHANGELOG.md (voci 2026-07-15/16) e le memoria di sessione del progetto. **Non fidarsi delle sezioni §2/§3/§5 sotto per queste aree** finché non vengono riscritte per intero — sono lasciate come riferimento storico sul resto del sistema (delta update, sicurezza, sessioni fondative), che restano invece accurate.

## 1. Identità progetto
- **App:** Skyrim AE Mod Manager (desktop, launcher+mod-manager tutto-in-uno, niente MO2).
- **Stack attuale:** Electron **43.1.0** + React 18.3 + TypeScript + **Vite 8** (rolldown, no esbuild) · DB **better-sqlite3 12.11.1** · test **Vitest 4** (motore reale `node:sqlite` in test) · **electron-builder 26** · Node **24**.
- **Repo:** git inizializzato, remote `github.com/guidonossardi001-hue/skyrim-mod-manager`, **65 commit**, CI GitHub Actions verde (`windows-latest`, lint→typecheck→test).
- **Working dir:** `C:\ai\skyrim-mod-manager` · DB runtime: `%APPDATA%\skyrim-ae-mod-manager\skyrim-manager.db`.
- **Distribuzione reale in uso:** eseguibile `release/win-unpacked/Skyrim AE Mod Manager.exe`, collegamento Desktop "Skyrim AE Fantasy Launcher.lnk" — **ricompilare (`npm run electron:build`) e verificare che l'asar contenga le modifiche dopo OGNI sessione**: è successo che il collegamento lanciasse codice di 3 giorni prima, resuscitando bug già fixati nel sorgente.
- **⚠️ Build gotcha permanente:** `package.json → build.disableAsarIntegrity: true` è **obbligatorio** su questa macchina (Smart App Control blocca l'exe se electron-builder patcha le risorse PE per l'asar-integrity, invalidando la firma Electron). `build.npmRebuild: false` è **obbligatorio** da quando è stata aggiunta la dipendenza `@nexusmods/fomod-installer-native` (shippa prebuild nativi; node-gyp la romperebbe tentando di ricompilarla). Non rimuovere nessuna delle due senza motivo forte.

## 2. Stato build & test (verificato 2026-07-16)
- **Test:** `npm test` → **749 test, 76 file, tutti verdi** (numero salito da 447 nella sessione precedente attraverso: mass-install/ESL budget, Electron 43 bump, catalog rebuild, LOOT masterlist reale, crash analyzer, ENB reale, conflitti chirurgici, FOMOD).
- **TypeScript:** `tsc --noEmit` 0 errori (renderer + electron).
- **Build:** `npm run build` (vite 8, renderer + bundle electron) verificato pulito su questa macchina. **`npm run electron:build` (electron-builder 26, NSIS) NON è stato rieseguito con lo stack/config attuali** (`build.disableAsarIntegrity:true` + `build.npmRebuild:false`, aggiunti per Smart App Control e per il modulo nativo FOMOD) — resta **da riverificare** con una build NSIS fresca, coerente con GO_NO_GO.md/TODO.md (PIVOT-13)/RISK_MATRIX.md (R11)/TASKS.md (Pack-Review-01). Il distributable oggi realmente verificato e in uso è `release/win-unpacked/Skyrim AE Mod Manager.exe`.
- **Schema DB:** `PRAGMA user_version` avanzato oltre la baseline storica (v8+) — verificare `electron/db/migrations.ts` per il numero esatto corrente, non fidarsi di un valore hardcoded qui.
- **Smoke reale sull'exe pacchettizzato:** ripetuto più volte in questa sessione dopo ogni modifica (avvio, boot log pulito, DB verificato via script esterno) — non solo nel preview browser.

## 3. Sottosistemi e file chiave (aggiornato con le aree toccate 2026-07-15/16; il resto è storico, vedi §0)
| Area | File | Stato |
|---|---|---|
| Avvio (SKSE-only) | `electron/launch/{bootstrapper,preflight,activeLaunch,addressLibrary,crashLogAnalyzer,crashEngine}.ts` | ✅ MO2 rimosso dal registry; crash auto-watch |
| Deploy (Data reale) | `electron/deploy/{plan,deployer,engine,lootOrder,ccHandler}.ts` | ✅ target game/instance, backup+purge vanilla, budget plugin |
| Plugin/load-order | `electron/plugins/{espParser,lootSort,lootMasterlist,masterlistCache,masterlistEngine,dirtyPluginCheck,crc32}.ts` | ✅ master reali TES4 + masterlist community reale |
| Catalogo | `electron/nexus/collections.ts`, `electron/main.ts` (IPC `catalog:*`) | ✅ solo import esplicito (Collection Nexus v2 / firmato); niente auto-seed |
| FOMOD | `electron/fomod/{fomodApply,collectionChoices,engine}.ts` | ✅ nuovo, motore ufficiale Vortex |
| ENB | `electron/enb/{enbManager,engine}.ts` | ✅ reale, sostituisce mock |
| Conflitti | `deployer.ts` (`previewDeploy`), `deploy/engine.ts` (`deploy:preview`/`deploy:prefer`) | ✅ chirurgico, mai disable |
| Download/installer | `electron/{downloadManager,installManager}.ts`, `electron/install/{extract,integrity,diskSpace,sevenZip}.ts` | ✅ sniff RAR-mascherato-da-.7z, api-provenance nel gate integrità, politica elimina-archivio |
| Performance | `electron/db/sqlite.ts` (pragmas+checkpoint), `electron/main.ts` (Menu/spellcheck/anti-ghost-window) | ✅ |
| Delta update (core, storico) | `electron/delta/*` | ✅ invariato da sessioni precedenti |
| Backup/sicurezza (storico) | `electron/backup/*`, Security Review Board fix (vedi CHANGELOG) | ✅ invariato |
| Steam/launch legacy | `electron/steam/*` | ✅ invariato salvo `detectSkse`/Address Library AE naming |

## 4. Decisioni architetturali consolidate
- **Nessun auto-trigger di rete o di popolamento dati non richiesto esplicitamente dall'utente** — lezione imparata a caro prezzo (l'auto-seed del bundle si ripresentava a ogni mount pagina; regola ora generale per masterlist LOOT/collection import/tutto ciò che scrive dati sostanziali).
- **Fail-safe sempre PRIMA di scrivere**: missing-master, ciclo dipendenze, budget plugin, spazio disco — tutti i gate del deploy bloccano prima di toccare un file, mai a metà.
- **Mai "disattiva la mod" come unica risoluzione conflitti** — la scelta chirurgica (peso di risoluzione) è lo standard.
- **Preferire dati pubblici stabili a binding nativi fragili quando possibile** (masterlist LOOT: YAML pubblico via `js-yaml`, non `node-loot`/libloot); quando un binding nativo è l'unica via realistica (FOMOD), usare SOLO pacchetti con N-API stabile e prebuild (mai compilazione locale in produzione).
- **Verificare sempre sul binario reale**, non solo sui test: più volte in questa sessione il codice sorgente era corretto ma l'eseguibile in uso era una build vecchia — il grep sull'`app.asar` dopo ogni build è ora prassi.
- Le decisioni storiche (single source of truth `installed_snapshot`, trust boundary manifest Ed25519, companion-mode sicurezza) restano valide e non toccate in questa sessione.

## 5. Come riprendere
1. `npm install` (verifica che `@nexusmods/fomod-installer-native` e `js-yaml` siano presenti).
2. `npm test` (deve restare verde, 749+).
3. Dev: `npm run electron:dev` (Vite + Electron). Produzione reale: `npm run electron:build`, poi **verificare col grep sull'asar** che le ultime modifiche siano dentro, poi lanciare `release/win-unpacked/Skyrim AE Mod Manager.exe` (stesso path del collegamento Desktop).
4. Config reale in uso: `deployTarget=game`, `modsPath=C:/ai/skyrim-mod-manager/data/mods`, `collectionSlug=frkafa`/`collectionRevision=159` (collezione "Opoal Collection." — 1739 mod, NSFW, OStim+Pandora).
5. Vedi CHANGELOG.md per il dettaglio di ogni feature 2026-07-15/16; TODO.md per il debito tecnico aperto (incluso il backlog dalla ricerca GitHub round 2: preflight DLL SKSE, validazione ESP avanzata, Save Doctor, rilevamento modifiche esterne al deploy, INI tuner, grass cache autopilota).

## 6. Documenti di stato (mantenere allineati)
SESSION_STATE · ROADMAP · TASKS · TODO · RISK_MATRIX · GO_NO_GO · CHANGELOG · MOD_CATALOG.
Documentazione tecnica storica: `docs/{DELTA-UPDATES,DELTA-UPDATES-v2,NEXUS-INTEGRATION,LAUNCH-WORKFLOW,GO-LIVE}.md` (invariata, ancora accurata per il sotto-sistema delta).
