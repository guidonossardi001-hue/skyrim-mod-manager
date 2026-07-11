# Security Review Report — Skyrim AE Mod Manager (Launcher Electron)

**Data**: 2026-07-11
**Ambito della review**: i 9 commit di sicurezza sul branch `main` (`d5944cf..b180ea5`), incluse le patch post-Red-Team. Aree: secret store (safeStorage/DPAPI), IPC filesystem intent-based (`fs:reveal-folder`/`open-download`/`read-dir` + `openTargets.ts`), gate consenso `nxm://`, hash-gating download (`integrity.ts` + `md5_search`), anti-rollback freshness (`freshness.ts` + floor pinnato). Obiettivo: verificare che le patch siano corrette e non abbiano introdotto regressioni o nuovi vettori.
**Stack analizzato**: Electron + TypeScript + React (main process Node, renderer isolato)
**Standard di riferimento**: OWASP ASVS 4.0 (Level 2) · CWE · CVSS 3.1 (solo Base Score)
**Board**: Application Security Engineer · Offensive Security Specialist · Defensive Security Engineer · Secure Software Architect · Electron Security Expert · Supply Chain Security Engineer · Code Security Reviewer

## Executive Summary

Le patch di sicurezza esaminate sono **corrette e chiudono i vettori che dichiarano di chiudere**; la verifica line-by-line non ha trovato regressioni funzionali né nuovi vettori introdotti dalle patch stesse. Il renderer è correttamente isolato (`contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, CSP attiva), quindi la superficie IPC è il vero trust boundary e l'hardening è applicato al livello giusto. Rimangono due rischi rilevanti **non** coperti dai 9 commit: (1) `settings:set` permette a un renderer compromesso di sovrascrivere path di sicurezza (`gamePath`/`mo2Path`) che alimentano lo spawn di processi al lancio — è la radice comune della classe "config-clobber" di cui la RCE `fs:reveal-folder` era un sintomo; (2) rischi supply-chain (Electron EOL effettivamente installato, installer non firmato). Nessun finding Critical residuo.

| Severità | Conteggio |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 2 |
| Low | 3 |
| Info | 5 |

**Decisione di gating**: N/A — audit standalone su codice già committato/pushato, nessuna decisione di integrazione collegata. I due finding High sono segnalati per remediation nel prossimo ciclo.

## Verifica delle patch post-Red-Team (esito)

| Patch | Esito verifica |
|---|---|
| RCE `fs:reveal-folder` (rifiuto UNC + `realpathSync.native` + `statSync isDirectory`) | ✅ Corretta. Un file/`.exe`/UNC non raggiunge più `shell.openPath`. Residuo TOCTOU minore → SRB-006. |
| Install fail-closed (`runInstall` rifiuta se `expectedHash()` null) | ✅ Corretta. Verificato che ogni download legittimo ha un hash risolvibile (colonna persistita dal gate, o `delta_changeset`). Accoppiamento con la persistenza → SRB-007. |
| Root confinement `open-download` (`validateInsideRoot` → solo `userData/downloads`) e `read-dir` (solo kind app-managed) | ✅ Corretta. Le root store-tunable non sono più raggiungibili da questi handler. |
| `canonical()` fail-closed su `realpath` throw | ✅ Corretta. Ritorna `null` → i chiamanti rifiutano; niente più literal non risolto che passa il containment. |
| Clock-rollback guard (`monotonicNow`) | ✅ Corretta. `now` non può scendere sotto l'ultimo `published_at` accettato. |
| Trust anchor su `app.isPackaged` (force `NODE_ENV=production`) | ✅ Corretta. In build pacchettizzato l'override pubkey e lo zero-floor sono disabilitati indipendentemente da `NODE_ENV`. |
| Purge legacy plaintext (`migrateLegacySecrets`) | ✅ Corretta. Il `store.delete` non è più gated sul ramo "non ancora migrato". |

## Finding — High

### [High] SRB-001: `settings:set` consente a un renderer compromesso di sovrascrivere path di sicurezza usati per lo spawn di processi

- **Ruolo che l'ha individuato**: Secure Software Architect / Offensive Security Specialist
- **Componente/File**: `electron/main.ts` (`ipcMain.handle('settings:set')`); consumato da `electron/launch/bootstrapper.ts` (`skseBootstrapper` → `join(gamePath,'skse64_loader.exe')`), `electron/steam/mo2.ts`, `electron/launcher/launcherService.ts` (`launchGame` → `spawn`)
- **CWE**: CWE-15 (External Control of System or Configuration Setting) + CWE-73 (External Control of File Name or Path)
- **CVSS 3.1**: 7.3 (AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H) — Base Score
- **ASVS**: V5.1.3 (validazione input server-side), V1.2 (trust boundary)

**Descrizione**
`settings:set` valida solo la *forma* della chiave (`/^[A-Za-z][A-Za-z0-9_]*$/`), non il *valore*. Per le chiavi che non sono in `SECRET_KEYS`, il valore viene scritto in `store.set(key, value)` senza alcuna validazione. Le chiavi `gamePath` e `mo2Path` sono percorsi di sicurezza: `bootstrapper.ts` costruisce `join(gamePath, 'skse64_loader.exe')` e `launcherService.launchGame` fa `spawn(exePath, …, {detached:true})`. Un renderer compromesso può quindi impostare `gamePath` su una directory controllata dall'attaccante contenente un `skse64_loader.exe` malevolo. Questa è la stessa radice ("config-clobber") di cui la RCE `fs:reveal-folder` (già patchata) era un sintomo: la patch reveal-folder ha chiuso il sink Explorer, ma il sink `spawn` sul percorso di lancio resta aperto.

**Impatto**
Concatenamento renderer→main: una compromissione del renderer (es. XSS in una descrizione mod / changelog renderizzato) imposta silenziosamente `gamePath`; al successivo click dell'utente su "GIOCA", il main esegue l'eseguibile scelto dall'attaccante con i privilegi dell'utente, detached. L'interazione utente richiesta (click su play) e l'accesso locale abbassano la severità sotto Critical, ma resta un percorso di esecuzione di codice pilotato dal componente meno fidato.

**Raccomandazione**
Validare i valori dei path-key in `settings:set`: (a) mantenere una allowlist dei nomi chiave che rappresentano percorsi, e per quelli rifiutare valori UNC (`^\\\\`, `^//`) e non-stringa; (b) meglio ancora, accettare i percorsi di sicurezza SOLO dal flusso `fs:pick-directory`/`fs:pick-file` (dialog utente) marcandoli come "trusted-origin", e rifiutare una scrittura diretta via `settings:set` per quelle chiavi; (c) difesa in profondità al lancio: prima dello `spawn`, confermare che l'eseguibile risolto sia sotto una radice attesa o mostrare all'utente il percorso reale nel checklist di avvio.

### [High] SRB-002: Versione di Electron EOL effettivamente installata (Chromium con CVE non patchate)

- **Ruolo che l'ha individuato**: Supply Chain Security Engineer / Electron Security Expert
- **Componente/File**: `package.json` (`electron ^33` dichiarato) vs `node_modules` reale (Electron 29.4.6, EOL) — cfr. cronologia progetto
- **CWE**: CWE-1104 (Use of Unmaintained Third Party Components) + CWE-1035 (componenti con vulnerabilità note)
- **CVSS 3.1**: 7.5 stimato (dipende dalle CVE Chromium specifiche; molte sono AV:N quando il renderer processa contenuto derivato da rete) — Base Score indicativo
- **ASVS**: V14.2.1 (componenti aggiornati e privi di vulnerabilità note)

**Descrizione**
`package.json` dichiara `electron ^33`, ma il `node_modules` usato per build/packaging resta Electron **29.4.6**, che è End-of-Life e non riceve più patch di sicurezza Chromium. Il renderer, pur isolato e con CSP, processa contenuto derivato da fonti esterne (metadati/descrizioni Nexus). Le mitigazioni (`sandbox:true`, CSP) riducono ma non azzerano l'esposizione a CVE del motore.

**Impatto**
Un renderer che renderizza contenuto malevolo derivato da rete potrebbe sfruttare una CVE Chromium nota e non patchata per evadere le protezioni del renderer; combinato con la superficie IPC, è il presupposto del modello di minaccia "renderer compromesso" su cui poggiano tutte le altre difese. Una difesa che assume "il renderer può essere compromesso" è indebolita se il renderer stesso gira su un motore con exploit pubblici.

**Raccomandazione**
Eseguire `npm install` per allineare `node_modules` a Electron ≥ 33 (già dichiarato in `package.json`), ricostruire i moduli nativi (`better-sqlite3`) per l'ABI corretto, ri-eseguire lo smoke test GUI, e ripubblicare. Automatizzare un controllo CI che fallisca se la major di Electron installata è EOL.

## Finding — Medium

### [Medium] SRB-003: Installer non firmato digitalmente

- **Ruolo che l'ha individuato**: Supply Chain Security Engineer
- **Componente/File**: pipeline di packaging `electron-builder` / artefatti `release/*.exe`
- **CWE**: CWE-347 (Improper Verification of Cryptographic Signature of Software)
- **CVSS 3.1**: 5.9 (AV:L/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:H) — Base Score
- **ASVS**: V10.3.2 (integrità del codice distribuito)

**Descrizione**
L'installer NSIS non è code-signed (noto dalla documentazione del progetto). Su Windows questo produce warning SmartScreen che abituano l'utente a ignorare gli avvisi, e non consente al SO di verificare l'integrità/provenienza del binario.

**Impatto**
Un attaccante che riesca a sostituire l'artefatto distribuito (MITM su un canale non-HTTPS, mirror compromesso) non incontra una barriera di firma; l'utente, già abituato a bypassare SmartScreen, esegue il binario. L'auto-update via GitHub Release verifica hash/firma del manifest ma il primo download dell'installer resta non firmato.

**Raccomandazione**
Firmare l'installer e l'eseguibile con un certificato code-signing (idealmente EV per reputazione SmartScreen immediata). Integrare la firma nella pipeline di release come step obbligatorio.

### [Medium] SRB-004: `secrets/nexus.key` in chiaro ancora su disco

- **Ruolo che l'ha individuato**: Application Security Engineer / Code Security Reviewer
- **Componente/File**: `secrets/nexus.key` (88 byte plaintext, gitignored, mai committato)
- **CWE**: CWE-312 (Cleartext Storage of Sensitive Information)
- **CVSS 3.1**: 4.6 (AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N) — Base Score
- **ASVS**: V2.10 / V6.2 (protezione dei segreti a riposo)

**Descrizione**
Il codice dell'app non legge più questo file (verificato: l'app usa il secret store cifrato, gli script usano `$NEXUS_API_KEY`), ma il file plaintext resta sul disco dell'utente. È leggibile da qualsiasi processo dello stesso utente e, a differenza del blob DPAPI (user+machine-bound), viaggia verbatim in backup/cloud-sync.

**Impatto**
Esfiltrazione della API key Nexus da parte di un processo same-user o di un agent di backup/sync, off-machine. La key va inoltre considerata compromessa per essere rimasta in chiaro.

**Raccomandazione**
Azione utente (non eseguibile dall'assistente): ruotare la key su nexusmods.com → Account → API Keys, poi eliminare il file (`del secrets\nexus.key`), infine reinserire la nuova key in Impostazioni (finisce cifrata). La cancellazione è sicura: nessun codice runtime legge il file.

## Finding — Low

### [Low] SRB-005: `fs:reveal-folder` apre comunque una directory arbitraria in Explorer per i kind store-tunable

- **Ruolo**: Defensive Security Engineer
- **Componente/File**: `electron/main.ts` (`fs:reveal-folder`, kind `game`/`mo2`)
- **CWE**: CWE-668 (Exposure of Resource to Wrong Sphere)
- **CVSS 3.1**: 3.3 (AV:L/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N)
- **ASVS**: V1.2

**Descrizione**
La patch reveal-folder richiede ora che il target sia una directory esistente (niente file/exe/UNC), ma il valore `game`/`mo2` resta store-tunable: un renderer compromesso può far aprire in Explorer una **directory** arbitraria del disco. Nessuna esecuzione, solo apertura di una finestra Explorer su un percorso a scelta.

**Raccomandazione**
Coperta indirettamente da SRB-001 (validare i path-key). In alternativa, confinare anche i kind `game`/`mo2` a radici attese, o richiedere conferma utente.

### [Low] SRB-006: TOCTOU tra `statSync(isDirectory)` e `shell.openPath` in `fs:reveal-folder`

- **Ruolo**: Code Security Reviewer
- **Componente/File**: `electron/main.ts` (`fs:reveal-folder`)
- **CWE**: CWE-367 (Time-of-check Time-of-use Race Condition)
- **CVSS 3.1**: 2.5 (AV:L/AC:H/PR:L/UI:R/S:U/C:L/I:L/A:N)
- **ASVS**: V1.11

**Descrizione**
Tra il controllo `statSync(realDir).isDirectory()` e `shell.openPath(realDir)` un processo locale concorrente potrebbe sostituire `realDir` (directory→junction verso un file/exe). Richiede capacità di race sul filesystem locale, che implica già una compromissione locale.

**Raccomandazione**
Rischio marginale accettabile. Se si vuole chiudere: aprire tramite un handle già risolto, o accettare che la finestra di race sia sub-millisecondo e a basso valore.

### [Low] SRB-007: Install fail-closed accoppiato al successo della persistenza dell'hash (disponibilità)

- **Ruolo**: Defensive Security Engineer
- **Componente/File**: `electron/downloadManager.ts` (`integrityGate` persiste `file_hash` best-effort) → `electron/installManager.ts` (`runInstall` fail-closed se hash null)
- **CWE**: CWE-703 (Improper Check or Handling of Exceptional Conditions)
- **CVSS 3.1**: 3.1 (AV:L/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L)
- **ASVS**: V7.4

**Descrizione**
Sul ramo `md5_search`, `integrityGate` persiste l'md5 verificato in `downloads.file_hash` con `try/catch` best-effort. Se quella `UPDATE` fallisse (evento raro), il download resta legittimo ma `expectedHash()` tornerebbe null e il fail-closed di `runInstall` rifiuterebbe l'installazione automatica successiva. È un trade-off corretto in ottica sicurezza (meglio rifiutare che estrarre non verificato), ma accoppia la disponibilità dell'install alla persistenza.

**Raccomandazione**
Passare l'hash verificato direttamente dal gate all'installer (o un flag "verified" sulla riga) invece di ri-derivarlo, così il successo del gate è autoritativo indipendentemente dalla persistenza.

## Osservazioni Info / Hardening

- **SRB-Info-1 (TOFU downgrade window)**: il floor pinnato difende il primo install fino alla release shippata, ma un MITM può comunque fermare un install fresco a qualsiasi release ≥ floor (non sotto). Mitigabile solo con floor più aggressivo o advisory di versione. Limite architetturale noto e accettato.
- **SRB-Info-2 (consenso = provenienza, non sicurezza)**: il gate `nxm://` + `md5_search` autenticano che un file appartiene a un dato mod/file, non che quella versione sia sicura. Un utente che approva consapevolmente una vecchia `fileId` vulnerabile passa il gate. Per design (il consenso è dell'utente).
- **SRB-Info-3 (floor operativo)**: `PINNED_MANIFEST_FLOOR`/`PINNED_CATALOG_FLOOR` vanno bumpati a ogni release, idealmente dallo script di firma/publish, per non restare indietro rispetto alla release shippata.
- **SRB-Info-4 (P5 residuo)**: `read-dir` usa ora `lstat` (no-follow) e serve solo kind app-managed; resta visibile il *nome* di un eventuale symlink dentro `backups/downloads/logs` (esistenza del link, non del target). Impatto trascurabile.
- **SRB-Info-5 (CI actions tag-pinned)**: `.github/workflows/ci.yml` referenzia `checkout@v4`/`setup-node@v4` per tag mobile invece che per SHA. Per una pipeline che non pubblica release il rischio è basso; pinnare per SHA è hardening consigliato.

## Note metodologiche

- Analisi **manuale** della logica delle patch e dei relativi trust boundary. **Non** è stata eseguita una scansione automatica delle CVE note nelle dipendenze (`npm audit`) né dell'albero transitivo — raccomandata come passo complementare, particolarmente in relazione a SRB-002 (Electron EOL).
- Il modello di minaccia assunto è "renderer compromesso via contenuto esterno" (coerente con un mod manager che renderizza metadati Nexus) + "processo same-user locale". Attack Vector prevalentemente Local: gli score riflettono questa natura desktop offline, più bassi rispetto a vulnerabilità equivalenti in servizi esposti in rete.
- La correttezza delle patch è stata verificata contro il codice sorgente attuale (`main` @ `b180ea5`) e contro la suite di test (547 test verdi, typecheck + lint puliti). La copertura test copre i moduli puri (`openTargets`, `integrity`, `freshness`, `nxmConsent`); gli handler IPC in `main.ts` restano coperti indirettamente (nessun unit test diretto sugli handler, coerente con la struttura del progetto).
