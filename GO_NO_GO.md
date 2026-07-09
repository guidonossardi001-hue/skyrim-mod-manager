# GO / NO-GO

> Decisione di rilascio. Ultimo aggiornamento: 2026-06-23.

## DECISIONE: **GO** (GO-LIVE READY)

Tutte le criticità bloccanti sono chiuse e verificate. I residui (RISK_MATRIX.md R1–R10) sono 🟨/🟩, non bloccanti, tracciati in TODO.md.

## Evidenze
- **Test:** 95 verdi / 14 file (unit + integration + chaos + stress + recovery + e2e) con SQLite reale (`node:sqlite`), Ed25519 reale, fs reale.
- **TypeScript:** 0 errori (renderer + electron CJS).
- **Renderer build:** OK. **App avviabile** (preview Dashboard, console pulita).
- **Schema:** `user_version=3`, migrazioni idempotenti/transazionali.
- **Sicurezza:** trust boundary manifest fail-closed; API key cifrata; CSP; single-instance; FK enforced.

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
- [x] Launch workflow companion-mode gated + UI
- [x] Nexus provider deferred-activation + cache

## Stato packaging (verificato 2026-06-23)
- [x] `npm run build` → `dist/` (renderer) + `dist-electron/{main,preload}.js` (bundle 313 KB)
- [x] `electron-builder --win --dir` → `release/win-unpacked/Skyrim AE Mod Manager.exe` (168 MB) + `app.asar` (53 MB)
- [x] `better_sqlite3.node` **UNPACKED** via `asarUnpack` (caricabile a runtime)
- [x] **Smoke runtime reale** (`electron.exe scripts/smoke.ts`): DB+migrazioni v3+integrity+verifica manifest firmato → PASS
- [ ] **NSIS installer (.exe)**: bloccato in questo ambiente da symlink-privilege Windows (winCodeSign). Fix = abilitare Developer Mode o eseguire come Admin sulla macchina di build, poi `electron-builder --win` (target nsis). NON è un difetto di codice.

## Checklist DEPLOY (pre-rilascio)
- [ ] `npm run setup` (electron-rebuild) su macchina di build
- [ ] `npm test` verde · `tsc` 0 errori · `npm run build`
- [ ] **Developer Mode / Admin** abilitato → `electron-builder --win` (NSIS) produce l'installer firmabile
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
- Regressione test (qualsiasi rosso) · errori tsc · build renderer fallita.
- Verifica firma manifest non fail-closed · perdita della chiave privata senza rotazione.
- Commit parziale osservato (snapshot avanzato con righe non terminali).
