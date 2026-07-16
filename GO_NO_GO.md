# GO / NO-GO

> Decisione di rilascio. Ultimo aggiornamento: 2026-06-23 → **aggiornato 2026-07-16** (vedi nota stack/packaging sotto).

## DECISIONE: **GO** (GO-LIVE READY: uso reale via `win-unpacked` E installer NSIS 1.0.1 riverificato sullo stack corrente — 2026-07-16)

Tutte le criticità bloccanti sono chiuse e verificate. I residui (RISK_MATRIX.md R1–R10) sono 🟨/🟩, non bloccanti, tracciati in TODO.md.

Il GO resta sostenibile: nella sessione 2026-07-16 l'app è stata usata realmente a scala (import + installazione di una collection Nexus da 1739 mod, deploy nella `Data` del gioco reale, preset ENB, crash-watch armato — vedi SESSION_STATE.md sez. 0 e CHANGELOG.md). Ma l'architettura descritta nelle Evidenze sotto (companion-mode/MO2/StockGame isolato) è nel frattempo superata da una serie di pivot — vedi CHANGELOG.md e SESSION_STATE.md per i dettagli completi.

## Evidenze
- **Test:** ~~95 verdi / 14 file~~ → **aggiornato: 749 test verdi / 76 file** (unit + integration + chaos + stress + recovery + e2e) con SQLite reale (`node:sqlite` / better-sqlite3), Ed25519 reale, fs reale. Progressione storica: 95 → 447 → 749 (vedi CHANGELOG.md/SESSION_STATE.md per gli step intermedi).
- **TypeScript:** 0 errori (renderer + electron CJS) — `tsc --noEmit` pulito, confermato anche sullo stack aggiornato.
- **Renderer build:** OK (`vite build`, oggi su Vite 8/rolldown). **App avviabile** (lanciata realmente dallo shortcut Desktop "Skyrim AE Fantasy Launcher" → SKSE interno, non più solo preview Dashboard).
- **Schema:** `user_version` avanzato oltre 3 (migrazione v8 ha aggiunto `resolution_weight` su mods/modlist_catalog, vedi PIVOT conflitti in CHANGELOG.md), migrazioni idempotenti/transazionali.
- **Sicurezza:** trust boundary manifest fail-closed; API key cifrata; CSP; single-instance; FK enforced. Più un batch di hardening successivo (SECURITY-01/SRB-001, validazione path, guardia clock-rollback, rifiuto exec UNC) — vedi CHANGELOG.md.

## Checklist critica (tutte ✅)
- [x] Manifest firmato Ed25519 + chiave pinnata + e2e con chiave reale
- [x] Allow-list host su download_url
- [x] Anti-replay (counter monotòno)
- [x] Hash archivio verificabile pre-estrazione
- [x] Snapshot whole-DB `VACUUM INTO` + integrity_check
- [x] PRAGMA FK/WAL/busy_timeout + delete FK-safe
- [x] Single-instance lock
- [x] Recheck idempotente (no UNIQUE clash)
- [x] Single source of truth + commit gated (no partial commit)
- [x] Recovery all'avvio
- [x] Comparatore versioni tollerante
- [x] Backup atomico + checksum (modulo; cablaggio in TODO T4)
- [x] Migration framework `user_version`
- [x] ~~Launch workflow companion-mode gated + UI~~ → **superato**: avvio oggi SKSE-only di default (MO2 fuori dal percorso), vedi PIVOT "avvio" in CHANGELOG.md/SESSION_STATE.md
- [x] ~~Nexus provider deferred-activation + cache~~ → **superato**: attivazione completata realmente (Premium attivo, API key verificata, collection reale importata/installata), non più solo "predisposto"

## Stato packaging (verificato 2026-06-23 — **stack nel frattempo cambiato, vedi nota 2026-07-16**)
- [x] `npm run build` → `dist/` (renderer) + `dist-electron/{main,preload}.js` (bundle 313 KB) *(su stack Electron 29.4.6/better-sqlite3 9.6.0-11.3.0, ormai storico)*
- [x] `electron-builder --win --dir` → `release/win-unpacked/Skyrim AE Mod Manager.exe` (168 MB) + `app.asar` (53 MB) *(idem, stack storico)*
- [x] `better_sqlite3.node` **UNPACKED** via `asarUnpack` (caricabile a runtime)
- [x] **Smoke runtime reale** (`electron.exe scripts/smoke.ts`): DB+migrazioni v3+integrity+verifica manifest firmato → PASS
- [x] **NSIS installer (.exe)**: ~~bloccato da symlink-privilege Windows (winCodeSign)~~ → **PRODOTTO 2026-07-16**: `Skyrim-AE-Fantasy-Launcher-Setup-1.0.1.exe`, nessun problema winCodeSign (cache presente); vedi nota RISOLTO sotto.

> **Nota 2026-07-16 — stack e packaging da riverificare.** Lo stack reale oggi è **Electron 43.1.0 / better-sqlite3 12.11.1 / electron-builder 26 / Vite 8 (rolldown) / Vitest 4 / Node 24**, non quello verificato sopra. Inoltre `electron-builder.yml`/config build ha ricevuto due cambi successivi a questa verifica (PIVOT 13): `build.disableAsarIntegrity: true` (necessario perché Windows Smart App Control blocca l'exe Electron ri-patchato/non firmato dopo il patching PE-resource dell'asar-integrity — tradeoff accettato: niente validazione runtime dell'integrità asar, ma l'exe resta quello firmato/reputato di Electron) e `build.npmRebuild: false` (necessario per il modulo nativo FOMOD `@nexusmods/fomod-installer-native`, che shippa prebuilds e verrebbe rotto da un rebuild node-gyp). Questi cambi rendevano il pacchetto NSIS documentato qui da riprodurre su questo stack.
>
> **RISOLTO 2026-07-16 (sera): build NSIS fresco ESEGUITO e VERIFICATO** su Electron 43.1.0 / electron-builder 26 con `disableAsarIntegrity:true` + `npmRebuild:false`: `release/Skyrim-AE-Fantasy-Launcher-Setup-1.0.1.exe` (132 MB) + `latest.yml` + `.blockmap` coerenti; win-unpacked rigenerata, app avviata e verificata viva (4 processi, provider Nexus attivo, log boot pulito). Nessun problema winCodeSign/symlink. Residuo per auto-update: GitHub Release `v1.0.1` coi 3 artefatti (azione utente); firma opzionale (`CSC_LINK`/`CSC_KEY_PASSWORD`).
>
> Il distributable oggi **effettivamente verificato e usato** è `release/win-unpacked/Skyrim AE Mod Manager.exe`, lanciato dallo shortcut Desktop "Skyrim AE Fantasy Launcher.lnk" → SKSE interno: funzionante, provato a scala con installazione reale di una collection da 1739 mod, deploy reale, FOMOD, ENB, crash-watch. Il verdetto GO per l'uso reale si basa su questa evidenza (win-unpacked), non sull'installer NSIS.

## Checklist DEPLOY (pre-rilascio)
- [ ] ~~`npm run setup` (electron-rebuild) su macchina di build~~ → **superato**: `build.npmRebuild:false` oggi in config (PIVOT 13, richiesto dal modulo nativo FOMOD che shippa prebuilds); nessun rebuild nativo da eseguire per better-sqlite3/FOMOD
- [ ] `npm test` verde (749+) · `tsc` 0 errori · `npm run build` (Vite 8)
- [x] **`electron-builder --win` (NSIS)** rieseguito e verificato su Electron 43/electron-builder 26 con `disableAsarIntegrity:true` (2026-07-16, build 1.0.1) — nessun privilegio speciale necessario in questo ambiente
- [ ] Chiave **privata** di firma nel CI secret store (NON nel repo; `secrets/` gitignored)
- [ ] `pinnedKey.ts`/`NOLVUS_MANIFEST_PUBKEY` = chiave pubblica di rilascio
- [ ] Manifest catalogo firmato con `scripts/sign_manifest.py` e pubblicato (T2)
- [ ] `.env` produzione: `NEXUS_ENABLED=false` (o `true` + chiave nello store cifrato)

## Checklist RECOVERY
- [ ] `integrity_check` all'avvio → se KO, ripristino da `pre-delta.db` (checksum-validato)
- [ ] `recoverOnStartup` reimposta righe changeset/download in volo a `pending`
- [ ] `installed_snapshot` avanzato solo da commit gated → resume/fail-safe, mai mezzo-commit
- [ ] Re-run `delta:apply` (idempotente) per riprendere

## Checklist ROLLBACK
- [ ] Snapshot `VACUUM INTO` pre-delta presente e valido
- [ ] Nessuna altra istanza con DB aperto (single-instance)
- [ ] Ripristino = copia snapshot → DB + `integrity_check`
- [ ] Verifica invariante: `installed_snapshot` ≡ release `from`

## Condizioni che farebbero scattare NO-GO
- Regressione test (qualsiasi rosso, oggi baseline 749/76 file) · errori tsc · build renderer fallita.
- Verifica firma manifest non fail-closed · perdita della chiave privata senza rotazione.
- Commit parziale osservato (snapshot avanzato con righe non terminali).
- **Windows Smart App Control blocca l'eseguibile Electron ri-patchato** (asar-integrity patching di electron-builder) → condizione mitigata da `build.disableAsarIntegrity:true` (PIVOT 13); se in futuro si richiedesse di riattivare la validazione asar-integrity, questa mitigazione andrebbe rivalutata prima del rilascio.
- Deploy che scrive nella `Data` del gioco reale in modo **non reversibile/non tracciato** (mancato backup `.smm-vanilla.bak` o manifest di purge) → oggi il deploy reale è consentito SOLO se reversibile/tracciato (PIVOT deploy); una regressione su questo punto è NO-GO.
