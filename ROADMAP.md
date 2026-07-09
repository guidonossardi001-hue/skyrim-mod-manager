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

## 🔜 Fase 5 — Attivazione & integrazione reale (PROSSIMA)
- [ ] Inserire chiave API Nexus reale (`NEXUS_ENABLED=true`) e verificare HTTP provider end-to-end.
- [ ] Catalogo remoto firmato: pubblicare manifest con `file_id`/`file_hash`/`version` per mod (lato producer).
- [ ] Apply delta end-to-end con rete reale (download multi-GB + estrazione) su macchina reale.
- [ ] Parsing reale `plugins.txt`/`loadorder.txt` dal profilo MO2 attivo (alimenta VerifyLoadOrder).

## 🔭 Fase 6 — Integrazione ecosistema (FUTURA)
- [ ] Orchestrazione tool esterni: LOOT (sort), xEdit (clean), DynDOLOD/xLODGen, Nemesis/Pandora (animazioni), Synthesis.
- [ ] Import/gestione collection Nexus + dependency tree automatico.
- [ ] Wabbajack import/export avanzato.
- [ ] Backup incrementali + compressione.
- [ ] Auto-update app (electron-updater) firmato.

## 🧭 Principi guida
Additivo · testato (motore reale) · fail-closed sulla sicurezza · companion-mode (mai modificare Steam/gioco) · niente C++ salvo necessità documentata.
