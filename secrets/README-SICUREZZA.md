# ⚠️ Materiale crittografico — stato e runbook di migrazione

Questa cartella conteneva segreti in chiaro. Stato attuale del programma di bonifica:

| Segreto | Stato | Dove vive ora |
|---|---|---|
| `release_priv.pem` | **DA MIGRARE** (vedi sotto) | → `%USERPROFILE%\.skyrim-release-keys\` cifrata |
| `nexus.key` | **DISMESSO** dal codice | L'app usa il secret store cifrato (DPAPI/safeStorage); gli script usano `$NEXUS_API_KEY` |
| `release_pub.pem` | Non è un segreto | Copia canonica tracciata: `docs/keys/release_pub.pem` |

## Migrazione di `release_priv.pem` (una tantum)

Tutti i produttori (`scripts/sign_manifest.py`, `scripts/build_remote_catalog.mjs`)
ora risolvono la chiave da `SKYRIM_RELEASE_PRIV_KEY_PATH` e **rifiutano** percorsi
dentro l'albero del progetto. La chiave su disco deve essere **cifrata**
(PKCS8 + passphrase).

```powershell
# 1. Cifra e sposta (chiede la passphrase con input nascosto; verifica la copia
#    contro la chiave pubblica pinnata PRIMA di suggerire la cancellazione):
node scripts/protect_release_key.mjs
#    → scrive %USERPROFILE%\.skyrim-release-keys\release_priv.pem

# 2. Blinda i permessi (solo il tuo utente) e rendi permanente l'env var:
icacls "%USERPROFILE%\.skyrim-release-keys\release_priv.pem" /inheritance:r /grant:r "%USERNAME%:F"
setx SKYRIM_RELEASE_PRIV_KEY_PATH "%USERPROFILE%\.skyrim-release-keys\release_priv.pem"

# 3. SOLO dopo l'OK del punto 1, cancella l'originale in chiaro:
del secrets\release_priv.pem
del secrets\release_pub.pem   # ridondante: la canonica è docs/keys/release_pub.pem
```

Con Python disponibile, l'equivalente è `python scripts/sign_manifest.py encrypt-key --in secrets/release_priv.pem`.

In CI: chiave e passphrase nel secret store della pipeline, esposte come
`SKYRIM_RELEASE_PRIV_KEY_PATH` e `SKYRIM_RELEASE_KEY_PASSPHRASE`.

## `nexus.key`

Nessun codice la legge più come fonte primaria (l'app: secret store cifrato nelle
Impostazioni; gli script e2e/smoke: `$env:NEXUS_API_KEY`). Il file può essere
eliminato. **Ruota comunque la chiave** su nexusmods.com → Account → API Keys:
è rimasta in chiaro su disco e va considerata esposta.

## Difese preventive

`.gitignore` esclude `secrets/*` (tranne questo README), `*.pem` (tranne la
pubblica in docs/keys), `*.key`, `.env*` e i database locali. La difesa vera
resta comunque una sola: nessuna chiave privata dentro il progetto.
