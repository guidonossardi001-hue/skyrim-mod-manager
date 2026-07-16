# ROADMAP

> Fasi completate e prossime. Aggiornare quando una fase cambia stato.

## ✅ Fase 0 — App base (COMPLETATA)
Electron+React+TS+SQLite; Dashboard, Lista Mod, Catalogo (103 mod), Download, Conflitti, Plugin, Strumenti, Profili, Statistiche, Backup, Impostazioni, Documentazione. Preview browser via mock.

## ✅ Fase 1 — Hardening & UX (COMPLETATA)
Throttling download, whitelist SQL, CSP + navigation hardening, cifratura API key (safeStorage), fix restore backup, confronto profili, plugin/notes sync, drag&drop + bulk, ErrorBoundary, virtualizzazione liste, rimozione 11 dipendenze inutilizzate, suite vitest.

## ✅ Fase 2 — Pipeline reale download/install (COMPLETATA)
Coda download (concorrenza, retry+backoff, circuit breaker), install pipeline (estrazione 7z/zip, deploy mods), long-path Windows, cache archivi, logger strutturato, risoluzione dipendenze + preflight + Stock-game concept.

## ✅ Fase 3 — Delta Update v2 (COMPLETATA, GO)
Manifest firmati Ed25519, signature verification, staging area (`delta_changeset`), commit atomico gated, rollback consistente, journal persistente, snapshot `VACUUM INTO`, integrity verification, migration framework `user_version`, recovery all'avvio, single-instance lock. Chaos/stress/failure-sim/e2e test.

## ✅ Fase 4 — Sottosistemi GO-LIVE (COMPLETATA)
Nexus provider deferred-activation (mock+http, cache TTL/ETag/offline), analizzatore compatibilità (ESL/ESP/ESM, SKSE/Address Library, version drift, load-order 254), rilevamento Steam + workflow di avvio companion-mode (10 stage gated) + UI preflight.

## ✅ Fase 5 — Attivazione & integrazione reale (COMPLETATA)
- [x] Inserire chiave API Nexus reale (`NEXUS_ENABLED=true`) e verificare HTTP provider end-to-end. Fatto: chiave reale inserita e verificata in app (Premium attivo), flusso Nexus provato a scala su una Collection reale di ~1739 mod (vedi Fase 7 / CHANGELOG).
- [x] Catalogo remoto firmato: pubblicare manifest con `file_id`/`file_hash`/`version` per mod (lato producer). Superato/ampliato: la via primaria di popolamento oggi non è più un manifest firmato lato producer ma l'**import diretto di Collection Nexus** (`electron/nexus/collections.ts`, GraphQL v2 ufficiale) — vedi Fase 7, PIVOT catalogo.
- [x] Apply delta end-to-end con rete reale (download multi-GB + estrazione) su macchina reale. Fatto e provato ben oltre la scala originaria: import → coda download Premium → installazione → FOMOD → deploy reale su 1739/1739 mod di una Collection reale.
- [x] Parsing reale `plugins.txt`/`loadorder.txt` dal profilo MO2 attivo (alimenta VerifyLoadOrder). Riformulato: il bisogno originale è soddisfatto in modo più autoritativo — MO2 è uscito dal percorso di avvio/load-order (vedi Fase 7, PIVOT avvio); il load order oggi viene dai master **reali** letti dall'header binario TES4 di ogni plugin (`electron/plugins/espParser.ts`), non da un parsing di file di testo MO2.

## 🔭 Fase 6 — Integrazione ecosistema (FUTURA)
- [x] LOOT (sort) — fatto in-house, non più "orchestrazione tool esterno": motore LOOT-like realizzato internamente (`electron/plugins/lootSort.ts` + masterlist community reale via `lootMasterlist.ts`/`masterlistCache.ts`), non dipende da LOOT.exe. Vedi Fase 7.
- [ ] xEdit (clean) — resta manuale/non automatizzato. Nota: auto-clean QAC via SSEEdit resta in backlog (TODO.md), tool non installato in questo ambiente.
- [ ] DynDOLOD/xLODGen — restano manuali, mai automatizzati.
- [x] Nemesis/Pandora (animazioni) — fatto: Pandora headless integrato (documentato in dettaglio nella collection Opoal/CHANGELOG).
- [x] Import/gestione collection Nexus + dependency tree automatico — fatto: import Collection Nexus end-to-end (parse slug/URL, GraphQL v2, scelte FOMOD del curatore) provato su una Collection reale di ~1739 mod. Vedi Fase 7.
- [ ] Wabbajack import/export avanzato — non affrontato in questa sessione, resta aperto.
- [ ] Backup incrementali + compressione — non affrontato in questa sessione, resta aperto.
- [ ] Auto-update app (electron-updater) firmato — stato non riverificato in questa sessione: da controllare se già trattato altrove prima di darlo per assodato o per aperto.

## ✅ Fase 7 — Pivot SKSE-only, deploy reale, FOMOD/LOOT/ENB/crash (COMPLETATA)
Sessione 2026-07-16: l'app passa da companion-mode read-only intorno a MO2 a launcher SKSE-only che scrive davvero nel gioco. Stack aggiornato a Electron 43.1.0, better-sqlite3 12.11.1, electron-builder 26, Vite 8 (rolldown), Vitest 4, Node 24 ~~(storico: Electron 29.4.6/33, better-sqlite3 9.6.0/11.3.0)~~. Suite test ~749/76 file verdi, tsc pulito, build OK ~~(storico: 95/220/447 ecc. — vedi TASKS.md/CHANGELOG per la progressione)~~.
- **Avvio**: MO2 rimosso dal percorso di default; avvio esclusivo via shortcut Desktop → SKSE interno (`electron/launch/bootstrapper.ts`, `preflight.ts` semplificato). `mo2Bootstrapper` resta esportato ma inutilizzato.
- **Deploy reale**: `deployTarget: 'game'` scrive nella cartella Data del gioco reale, reversibile (backup `.smm-vanilla.bak`, hardlink per-file quando serve, purge esatto da manifest, euristica di pulizia disattivata sul target reale).
- **Load order in-house**: `espParser.ts` (master reali da header TES4, verificato 355/355), `lootSort.ts` (topological sort, blocco su master mancante/ciclo), `lootMasterlist.ts`/`masterlistCache.ts` (masterlist community reale github loot/skyrimse, fetch solo su azione utente), `dirtyPluginCheck.ts`/`crc32.ts` (rilevamento dirty plugin via CRC32), `deploy/lootOrder.ts` (adapter che blocca prima di scrivere).
- **Budget plugin**: blocco pre-scrittura (`errorKind: 'plugin-limit'`) su 254 slot full / 4096 slot light, contati dai flag reali dell'header TES4.
- **Conflitti**: nessuna disattivazione mod come risoluzione; `resolution_weight` (migrazione v8) + planner deploy + UI "Sovrascritture file (piano di deploy)" con dry-run reale (`deploy:preview`) e "Inverti precedenza" (`deploy:prefer`).
- **Catalogo**: nessun auto-seed silenzioso; bottone "Svuota catalogo" (`catalog:wipe`) + flag `catalogSeedDisabled`. Via primaria di popolamento: Import Collection Nexus (`electron/nexus/collections.ts`, GraphQL v2 ufficiale scritto a mano perché il pacchetto npm pubblicato non lo espone ancora). L'import Vortex storico (`data/vortex-collections-backup.json`, 4.568 mod/329 GB) è stato **eliminato deliberatamente** su richiesta utente: qualunque item storico di TODO/TASKS/RISK_MATRIX basato su quei dati è superato.
- **Nexus reale**: Premium attivo, API key reale verificata, Collection reale importata e installata interamente end-to-end ("Opoal Collection.", slug `frkafa`, revisione 159, ~1739 mod) — chiude/supera i rischi storici su "Nexus non testato a scala".
- **FOMOD**: motore ufficiale Vortex (`@nexusmods/fomod-installer-native`, prebuilds, no rebuild necessario) — `electron/fomod/fomodApply.ts` (journal+rollback+idempotenza), `collectionChoices.ts` (scelte del curatore dalla collection), `engine.ts` (IPC). Card Strumenti → FOMOD.
- **ENB**: gestione preset reale (`electron/enb/`), copia+backup+manifest, non più mock.
- **Crash**: analisi automatica reale post-lancio (`crashLogAnalyzer.ts`, `crashEngine.ts` con poll 30s per 3h), verificata su log reale 835 righe.
- **Affidabilità download**: `sniffArchiveKind` (magic byte reali) risolve la root cause di download RAR serviti con estensione `.7z`; verdetto integrità `api-provenance`; bottone "Riprova falliti".
- **Spazio disco**: eliminazione archivio post-install di default; pulizia one-shot 1737 archivi/73,8 GB liberati.
- **Packaging**: `disableAsarIntegrity:true` (richiesto da Windows Smart App Control su binari ri-patchati) e `npmRebuild:false` (richiesto dal modulo nativo FOMOD) aggiunti — **invalidano potenzialmente** lo stato "GO_NO_GO packaging già verificato" dei documenti precedenti (Electron 29/33): da riverificare con una build NSIS fresca su questo stack, non dato per assodato.
- **Sicurezza**: nuovo batch di hardening (validazione path `settings:set`, rifiuto exec UNC, purga plaintext residuo, guardia clock-rollback) — dettagli in CHANGELOG.md. Backlog nuovo emerso da ricerca GitHub (round 2, focus FOMOD) aggiunto in TODO.md: preflight DLL SKSE, validazione header ESP, "Save Doctor", rilevamento external-changes sul deploy reale, INI tuner BethINI Pie, grass cache autopilota, auto-clean QAC via SSEEdit.

## 🧭 Principi guida
Additivo · testato (motore reale) · fail-closed sulla sicurezza · niente C++ salvo necessità documentata.
~~companion-mode (mai modificare Steam/gioco)~~ — **superato dal PIVOT deploy reale (Fase 7)**: il deploy può scrivere davvero nella cartella Data del gioco reale, ma **solo in modo reversibile e tracciato** (backup `.smm-vanilla.bak`/hardlink per-file, manifest, purge esatto) — mai distruttivo silenzioso. Principio attuale: *scrittura reale consentita solo se reversibile e tracciata*.
