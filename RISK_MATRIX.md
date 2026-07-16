# RISK_MATRIX

> Rischi residui e loro mitigazione. Severità = Probabilità × Impatto. Nessun rischio è bloccante per la build.
> Ultimo aggiornamento: 2026-07-16.

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
| ~~R1~~ | ~~Manifest producer senza `file_id`/`file_hash`/`version`~~ → **CHIUSO** | — | — | 🟩 | Superato dal flusso Collection reale: `fetchCollectionRevision` (GraphQL v2 ufficiale Nexus, `electron/nexus/collections.ts`) valorizza sempre `nexus_file_id`/hash/versione dalla risposta autenticata · PIVOT 6/7 |
| ~~R2~~ | ~~Apply delta e2e con rete reale non testato in CI headless~~ → **CHIUSO** | — | — | 🟩 | Provato a scala reale: import → coda download Premium → installazione FOMOD → deploy, 1739/1739 mod della Opoal Collection su rete reale · PIVOT 7 |
| R3 | File deployati non snapshottati byte-a-byte | Bassa | Medio | 🟨 | Re-download content-addressed + ri-estrazione idempotente (design) |
| ~~R4~~ | ~~Chiave API Nexus assente~~ → **CHIUSO** | — | — | 🟩 | Premium attivo; chiave reale inserita e riverificata più volte in sessione; provata a scala (1739 mod reali installati) · PIVOT 7 |
| ~~R5~~ | ~~`backupManager` non cablato su `snapshot.ts`~~ → **CHIUSO** | — | — | 🟩 | `backupManager` delega al core hardened (atomic+checksum+VACUUM); restore rifiuta i corrotti; lockstep provato · `backup/manager.test.ts` (5) |
| ~~R6~~ | ~~`plugins.txt` reale non parsato dal probe launch~~ → **CHIUSO** (nota: meccanismo cambiato) | — | — | 🟩 | Il rischio originale non è più pertinente: MO2 è uscito dal percorso di avvio (SKSE-only, PIVOT 1) e il load order oggi non dipende da `plugins.txt` ma dai master reali letti dall'header binario TES4 di ogni plugin (`electron/plugins/espParser.ts`, verificato 355/355) + `lootSort.ts` topological sort — meccanismo più autoritativo · PIVOT 3 |
| R7 | Versione runtime Skyrim / SKSE compat. euristica | Bassa | Basso | 🟩 | `gameVersionSupported=null`→ok (no blocco spurio) · T5 |
| R8 | Integrazione profonda tool esterni (LOOT/xEdit/…) assente | Bassa | Basso | 🟩 | **Aggiornato**: LOOT e Pandora oggi integrati in-house/headless (masterlist community reale via `lootMasterlist.ts`/`masterlistCache.ts`, topological sort `lootSort.ts`, dirty-check CRC32 `dirtyPluginCheck.ts`, PIVOT 3). Resta aperto solo per xEdit/DynDOLOD/xLODGen/Synthesis/SSEEdit — mai automatizzati, restano manuali per design |
| R9 | Chiave privata di firma fuori dal repo | — | Alto se persa | 🟨 | `secrets/` gitignored → **CI secret store**; rotazione via `NOLVUS_MANIFEST_PUBKEY` |
| R10 | Non-Windows: registry/tasklist falliscono | Bassa | Basso | 🟩 | Degrado grazioso (`steam.installed=false`); app è Windows-target |
| R11 | NSIS installer non producibile in questo ambiente | Bassa | Basso | 🟩 | winCodeSign richiede symlink → Developer Mode/Admin sulla macchina di build. App **già impacchettata** (`win-unpacked`, better-sqlite3 unpacked) + smoke runtime PASS. Non è difetto di codice. ⚠️ **Da riverificare**: la configurazione di build è cambiata da allora (`build.disableAsarIntegrity:true` + `build.npmRebuild:false`, richiesti dal modulo nativo FOMOD, PIVOT 13) — questo verdetto va confermato con una build NSIS fresca su questo stack, non va dato per assodato così com'è |
| R12 | Deploy diretto sulla cartella `Data` del gioco reale (install Steam), non più solo su target isolato | Media | Alto | 🟨 | File pre-esistenti salvati come `<file>.smm-vanilla.bak` prima di essere sovrascritti; purge del manifest li ripristina; junction degradano a hardlink per-file con backup quando la dir esiste già; euristica di pulizia disattivata sul target gioco reale (solo purge esatto da manifest) — mai distruttivo silenzioso · PIVOT 2 |
| R13 | Smart App Control blocca l'eseguibile Electron ripatchato (asar-integrity) dopo il packaging | Bassa | Medio | 🟩 | `build.disableAsarIntegrity:true` accettato come tradeoff: nessuna validazione runtime dell'integrità dell'asar, ma l'exe resta quello firmato/reputato di Electron · PIVOT 13 |
| R14 | Instabilità nota della modlist installata (Opoal Collection: CTD documentati dal creatore su `nvwgf2umx.dll`/`KERNELBASE.dll`/`CommunityShaders.dll`, freeze UI 30min-1h) | Media | Medio | 🟨 | Non è un difetto del launcher ma un rischio intrinseco della modlist scelta dall'utente; mitigato dal crash-analyzer automatico (`crashLogAnalyzer.ts` + `armCrashWatch`, poll 30s per 3h) che identifica il modulo colpevole invece di lasciare l'utente al buio · PIVOT 10 |

## Verdetto rischio complessivo
Nessun residuo 🟥/🟧. Il cambio di rotta architetturale della sessione (SKSE-only, deploy reale, LOOT-like in-house, catalogo via Collection Nexus reale — vedi CHANGELOG.md/SESSION_STATE.md) ha chiuso R1/R2/R4/R6 e declassato R8. In cambio ha aperto una superficie di rischio nuova ma mitigata e tracciata: R12 (scrittura reale su Steam, mitigata da backup+manifest+purge reversibili), R13 (Smart App Control, tradeoff accettato) e R14 (instabilità intrinseca della modlist Opoal, mitigata dal crash-analyzer automatico). R11 (NSIS) resta 🟩 ma **da riverificare** con una build fresca su questo stack per via dei cambi di build.disableAsarIntegrity/npmRebuild in PIVOT 13. Tutti i 🟨/🟩 restanti sono mitigati e tracciati in TODO.md. **Coerente con GO**, condizionato alla riverifica di R11 (vedi GO_NO_GO.md).
