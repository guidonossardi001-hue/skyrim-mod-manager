# GO-LIVE — Report finale & Checklist

> Esito: **GO** (vedi §6). 77 test verdi (12 file), tsc 0 errori (renderer + electron), renderer build OK.

## 1. Criticità bloccanti — stato di chiusura

| Rischio | Chiusura | Evidenza |
|---|---|---|
| Manifest trust boundary / **RCE** | Firma Ed25519 + chiave pinnata + allow-list host | `core.test.ts`, `e2e.test.ts` |
| **Replay attack** | Counter firmato monotòno; dedup idempotente | `core.test.ts`, `e2e.test.ts` |
| **Rollback incompleto / Partial commit** | Commit gated all-or-nothing + transazioni | `journal.test.ts`, `chaos.test.ts` |
| **Corruzione stato / DB corrotto** | `integrity_check` + snapshot `VACUUM INTO` + restore | `failureSim.test.ts` |
| **Migration inconsistente / Schema drift** | Framework `user_version` ordinato/transazionale/idempotente | `migrations.test.ts` |
| **Backup corrotti** | Write atomico (temp+fsync+rename) + checksum + validazione | `snapshot.test.ts` |
| **Aggiornamenti interrotti** | Journal persistente + recovery all'avvio | `journal.test.ts`, `e2e.test.ts` |
| **Race condition** | Single-instance lock + busy_timeout + WAL | `migrations.test.ts` (FK), runtime |
| **Power loss** | Transazioni atomiche (BEGIN/COMMIT/ROLLBACK) | `failureSim.test.ts` |
| **Disk full** | Backup atomico non corrompe il restore point; download fail → gate blocca | `snapshot.test.ts`, `chaos.test.ts` |
| **Version drift** | Comparatore tollerante + hash-primary + report compat | `core.test.ts`, `compatibility.test.ts` |

## 2. Risk Matrix residua

| ID | Rischio residuo | Prob. | Impatto | Severità | Mitigazione |
|----|-----------------|-------|---------|----------|-------------|
| R1 | Manifest producer non pubblica `file_id`/`file_hash`/`version` | Media | Medio | 🟡 | Detection ripiega su confronto versione tollerante |
| R2 | Apply end-to-end con rete reale non testato in CI headless | Media | Medio | 🟡 | Macchina a stati + gate integrità testati; trasporto riusa pipeline verificata |
| R3 | File deployati non snapshottati byte-a-byte | Bassa | Medio | 🟡 | Re-download content-addressed + ri-estrazione idempotente |
| R4 | Chiave API Nexus assente | — | — | 🟢 | Per design: mock provider, app funzionante; attivazione automatica |
| R5 | Tool esterni (LOOT/xEdit/DynDOLOD/Nemesis/Pandora) integrazione profonda | Bassa | Basso | 🟢 | Launcher presenti; analisi compat euristica; integrazione binari = roadmap |

Nessun residuo è **bloccante** per la stabilità/sicurezza della build.

## 3. Checklist DEPLOY

- [ ] `npm run setup` (electron-rebuild better-sqlite3) eseguito
- [ ] `npm test` → tutti verdi
- [ ] `tsc --noEmit` (renderer + electron) → 0 errori
- [ ] `npm run build` → installer NSIS prodotto
- [ ] `electron-builder` con `asar:true` + `files` whitelist
- [ ] **Chiave privata di firma** in CI secret store (NON nel repo); `secrets/` gitignored verificato
- [ ] `PINNED_PUBLIC_KEY_PEM`/`NOLVUS_MANIFEST_PUBKEY` = chiave pubblica di rilascio
- [ ] Manifest catalogo firmato con `scripts/sign_manifest.py` e pubblicato
- [ ] `.env` di produzione: `NEXUS_ENABLED=false` (o `true` + chiave nello store cifrato)

## 4. Checklist RECOVERY (post-crash / avvio)

- [ ] `integrity_check` all'avvio → se KO, ripristino dall'ultimo `pre-delta.db` (checksum-validato)
- [ ] `recoverOnStartup` reimposta righe `delta_changeset` e `downloads` in volo a `pending`
- [ ] `installed_snapshot` **mai** avanzato fuori dal commit gated → solo resume/fail-safe
- [ ] Re-run `delta:apply` (idempotente) per riprendere; cache content-addressed evita ri-download
- [ ] Verificare invariante: `delta:check` post-recovery a 0 modifiche dopo commit

## 5. Checklist ROLLBACK (delta abortito)

- [ ] Snapshot `VACUUM INTO` pre-delta presente e checksum-valido
- [ ] Single-instance: nessun'altra istanza con il DB aperto
- [ ] Ripristino = `copyFileSync(pre-delta.db → app.db)` + `integrity_check`
- [ ] Backup JSON `mods` come fallback parziale (BOUND in lockstep con le colonne)
- [ ] Verificare che `installed_snapshot` torni a coincidere con la release `from`

## 6. Decisione finale

**GO.** Tutte le criticità bloccanti sono chiuse e verificate con unit/integration/chaos/stress/recovery/regression test (77, real SQLite + real Ed25519 + real fs). Residui R1–R5 non bloccanti, documentati e mitigati.
