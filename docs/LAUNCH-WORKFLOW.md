# Rilevamento Steam & Workflow di Avvio (Companion Mode)

> Stato: **IMPLEMENTATO + TESTATO**. L'app **non modifica mai Steam/gioco** — legge, verifica, e **blocca l'avvio** se mancano componenti critici, fornendo istruzioni di correzione.

## Architettura

```
src/lib/launchWorkflow.ts     runLaunchWorkflow(env) → report   (PURO, 10 stage, gate canLaunch)
electron/steam/vdf.ts         parseVdf / getLibraryPaths / parseAppManifest   (PURO)
electron/steam/detect.ts      detectSteamEnv()  (Windows: registry, processi, fs — READ-ONLY)
electron/launch/preflight.ts  buildLaunchEnv(db,store) + runPreflight + executeLaunch  (gate enforced in MAIN)
src/components/ui/LaunchPreflight.tsx   modale checklist (blocca il pulsante se non lanciabile)
```

## Rilevamento Steam (read-only)
- **Percorso Steam:** registro `HKCU\Software\Valve\Steam\SteamPath` (+ `HKLM\…\WOW6432Node`), fallback ai path comuni.
- **Librerie aggiuntive:** `steamapps/libraryfolders.vdf` → `getLibraryPaths` (formato nuovo e legacy).
- **AppID Skyrim (489830):** `appmanifest_489830.acf` in ogni libreria → `installdir` → verifica esistenza cartella.
- **Ownership (per quanto disponibile):** presenza dell'appmanifest = gioco posseduto+installato (la verifica reale richiederebbe la Steam Web API, fuori companion-mode).
- **Stato Steam:** `tasklist` per `steam.exe` prima del lancio.

## Flusso di avvio (10 stage, in ordine)
`PreFlightCheck → VerifySteam → VerifySkyrim → VerifySKSE → VerifyDependencies → VerifyModlist → VerifyLoadOrder → VerifyManifest → VerifyBackups → LaunchMO2OrSKSE`

| Stage | Critico (blocca)? | Esempio fail |
|---|---|---|
| VerifySteam | Steam **non installato** = sì; chiuso = avviso | "Installa Steam" |
| VerifySkyrim | sì | "Installa Skyrim AE da Steam (489830)" |
| VerifySKSE | sì (mancante/incompatibile) | "Aggiorna SKSE alla build del runtime" |
| VerifyDependencies | sì (Address Library mancante/errata) | "Installa Address Library per AE" |
| VerifyModlist | no (avviso) | "Mod mancanti: …" |
| VerifyLoadOrder | sì (>254 ESP/ESM) | "Converti plugin in ESL" |
| VerifyManifest | no (skip se delta non in uso) | — |
| VerifyBackups | no (avviso) | "Crea un backup" |
| LaunchMO2OrSKSE | sì (target non valido) | "Reimposta percorso MO2" |

`canLaunch = nessun check critico fallito`. Il **gate è applicato nel main** (`executeLaunch`): se non lanciabile, **nessun processo viene avviato** e si ritorna il report con le correzioni.

## Companion mode — garanzie
- Nessuna scrittura su Steam o sul gioco.
- Solo lettura di registro/file/processi locali.
- Avvio impedito se mancano componenti critici.
- Messaggi diagnostici chiari + fix per ogni problema.

## Avvio "un pulsante"
Dashboard → **Avvia Skyrim AE** → modale preflight: 10 controlli con stato/dettaglio/fix; il pulsante **Avvia** è abilitato **solo** se tutti i critici passano; al lancio esegue MO2 (o SKSE) tramite `executeLaunch`.

## Test (`src/lib/launchWorkflow.test.ts`, `electron/steam/vdf.test.ts` — 20)
Simulati: Steam chiuso (avviso) · Steam non installato (blocco) · Skyrim mancante (blocco) · SKSE incompatibile (blocco) · Address Library errata (blocco) · MO2 corrotto (blocco) · modlist incompleta (avviso) · load order >254 (blocco) · ordine di blocco in pipeline. Parser VDF (nuovo/legacy/appmanifest).

## Limiti noti (best-effort, non bloccanti)
- Versione runtime Skyrim e compatibilità SKSE: euristica via `version-*.bin` di Address Library; `null` ⇒ trattato come ok.
- `plugins.txt` reale non parsato dal probe (richiede il path del profilo MO2): `VerifyLoadOrder` usa l'analizzatore compat quando i plugin sono disponibili.
