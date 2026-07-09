# RISK_MATRIX

> Rischi residui e loro mitigazione. Severità = Probabilità × Impatto. Nessun rischio è bloccante per la build.
> Ultimo aggiornamento: 2026-06-23.

## Legenda severità
🟥 Critico · 🟧 Alto · 🟨 Medio · 🟩 Basso/Accettato

## Rischi chiusi (storici, per tracciabilità)
| ID | Rischio | Chiusura | Evidenza |
|----|---------|----------|----------|
| C1 | RCE supply-chain (manifest non firmato / url arbitrario) | Firma Ed25519 pinnata + allowlist host + fail-closed | `core.test.ts`, `e2e.test.ts` |
| C2 | Perdita dati irrecuperabile (DB corrotto) | `integrity_check` + snapshot `VACUUM INTO` + restore | `failureSim.test.ts` |
| C3 | Integrità post-extract / content-length only | `verifyFileHash` pre-estrazione (streaming) | `snapshot.test.ts` |
| M3 | Replay/downgrade attack | Counter firmato monotòno + dedup idempotente | `core.test.ts`, `e2e.test.ts` |
| A1 | UNIQUE violation su recheck | recordChangeset delete-all-then-insert | `journal.test.ts` |
| A2 | Partial commit / doppia fonte di verità | Commit gated all-or-nothing; bump solo a commit | `chaos.test.ts` |
| A3 | FK off / no WAL / no busy_timeout | `applyPragmas` + delete FK-safe | `migrations.test.ts` |
| A4 | Race multi-istanza | `requestSingleInstanceLock` | runtime |
| A5 | Update interrotto in limbo | `recoverOnStartup` all'avvio | `journal/e2e/failureSim` |
| A6 | Throw su versioni Nexus non-semver | Comparatore tollerante mai-throw | `core.test.ts` |
| M1 | Migration inconsistente / schema drift | Framework `user_version` ordinato/idempotente | `migrations.test.ts` |
| M2 | Backup corrotti | Write atomico + checksum (modulo pronto) | `snapshot.test.ts` |

## Rischi residui APERTI
| ID | Rischio | Prob. | Impatto | Severità | Mitigazione / Azione (TODO) |
|----|---------|-------|---------|----------|------------------------------|
| R1 | Manifest producer senza `file_id`/`file_hash`/`version` | Media | Medio | 🟨 | Detection ripiega su confronto versione tollerante · T2 |
| R2 | Apply delta e2e con rete reale non testato in CI headless | Media | Medio | 🟨 | Macchina a stati + gate testati; trasporto = pipeline verificata · T3/Act-03 |
| R3 | File deployati non snapshottati byte-a-byte | Bassa | Medio | 🟨 | Re-download content-addressed + ri-estrazione idempotente (design) |
| R4 | Chiave API Nexus assente | — | — | 🟩 | Per design: mock provider, app funzionante; attivazione automatica · T1 |
| ~~R5~~ | ~~`backupManager` non cablato su `snapshot.ts`~~ → **CHIUSO** | — | — | 🟩 | `backupManager` delega al core hardened (atomic+checksum+VACUUM); restore rifiuta i corrotti; lockstep provato · `backup/manager.test.ts` (5) |
| R6 | `plugins.txt` reale non parsato dal probe launch | Media | Basso | 🟩 | VerifyLoadOrder non blocca senza dati; parser pronto · T3/Debt-01 |
| R7 | Versione runtime Skyrim / SKSE compat. euristica | Bassa | Basso | 🟩 | `gameVersionSupported=null`→ok (no blocco spurio) · T5 |
| R8 | Integrazione profonda tool esterni (LOOT/xEdit/…) assente | Bassa | Basso | 🟩 | Launcher presenti + analisi compat euristica · Eco-01 |
| R9 | Chiave privata di firma fuori dal repo | — | Alto se persa | 🟨 | `secrets/` gitignored → **CI secret store**; rotazione via `NOLVUS_MANIFEST_PUBKEY` |
| R10 | Non-Windows: registry/tasklist falliscono | Bassa | Basso | 🟩 | Degrado grazioso (`steam.installed=false`); app è Windows-target |
| R11 | NSIS installer non producibile in questo ambiente | Bassa | Basso | 🟩 | winCodeSign richiede symlink → Developer Mode/Admin sulla macchina di build. App **già impacchettata** (`win-unpacked`, better-sqlite3 unpacked) + smoke runtime PASS. Non è difetto di codice. |

## Verdetto rischio complessivo
Nessun residuo 🟥/🟧. Tutti i 🟨/🟩 sono mitigati e tracciati in TODO.md. **Coerente con GO** (vedi GO_NO_GO.md).
