# ⚠️ ATTENZIONE — Materiale crittografico sensibile

Questa cartella contiene **segreti in chiaro** che NON devono mai lasciare questa macchina:

- `release_priv.pem` — chiave privata Ed25519 che firma i manifest delta.
  È la **root of trust** dell'intero meccanismo di aggiornamento: chiunque la
  possieda può firmare manifest accettati da tutte le installazioni.
- `nexus.key` — credenziale personale dell'API Nexus Mods.

## Azioni raccomandate (in ordine di priorità)

1. **Sposta `release_priv.pem` fuori dall'albero del progetto** — in un secret
   store di CI (GitHub Actions Secrets, ecc.) o in un gestore di credenziali,
   e cancella la copia locale. Il codice di firma (`scripts/sign_manifest.py`)
   dovrebbe leggerla da una variabile d'ambiente o da un percorso esterno.
2. **Cifra la chiave privata** se deve restare su disco:
   `python scripts/sign_manifest.py` va aggiornato per usare
   `BestAvailableEncryption(passphrase)` invece di `NoEncryption()`.
3. **Ruota la API key Nexus** (`nexus.key`) se questa cartella è mai stata
   copiata/condivisa, e usa il campo Impostazioni dell'app (cifrato con DPAPI
   via safeStorage) invece del file in chiaro.
4. Il progetto ora ha un `.gitignore` che esclude `secrets/` e `*.pem`, ma la
   difesa vera è non avere mai la chiave privata dentro il progetto.
