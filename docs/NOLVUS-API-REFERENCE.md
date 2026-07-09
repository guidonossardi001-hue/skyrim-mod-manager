# Nolvus Installer API — reference (reverse-engineered)

> Fonte: `C:\nolvs\Vcc.Nolvus.Api.Installer.dll` (assembly .NET dell'installer Nolvus
> ufficiale, namespace `Vcc.Nolvus.Api.Installer`). Estratto via metadati .NET
> (nomi tipi/metodi, route RestEase, proprietà DTO). **Solo riferimento**: è
> l'infrastruttura **proprietaria** di Nolvus (server loro, auth Bearer con login),
> quindi non viene integrata né chiamata dal nostro progetto. Documentata per validare
> il nostro design (catalogo/delta) e per individuare feature di robustezza adottabili.

## Architettura
- **`ApiService`** — client HTTP generico: `Get`/`Post`/`Put` con varianti `*PolyMorphic`
  (deserializzazione su tipo concreto) e `GetUnRestricted` (chiamate senza auth).
- **`TokenService`** — autenticazione **Bearer** con refresh: `Authenticate`,
  `GetAuthenticationToken`, `GetNewAuthenticationToken` (rinnovo). Token model:
  `AccessToken`, `TokenType` (Bearer), `ExpiresAt`/`ExpiresIn`, `IsValidAndNotExpiring`.
- **`InstallerController`** — endpoint applicativi (vedi sotto).
- Stack: `HttpClient`, `Newtonsoft.Json`. PDB: `Vcc.Nolvus.Api.Library.Installer`.

## Route (base `api/{0}/installer`, `{0}` = contesto/versione)
| Endpoint | Scopo |
|---|---|
| `/getnolvusversions`, `/getdebugnolvusversions` | Liste versioni della modlist |
| `/getnolvusvariants` | Varianti (es. Ascension/Redux/…) |
| `/getnolvusvariantminrequirement`, `/getnolvusvarianttecrequirement` | Requisiti hardware min/raccomandati |
| `/getgpus` | Elenco GPU (rilevamento + match requisiti) |
| `/getpackage`, `/getlatestpackage`, `/getlatestpackages`, `/getlatestpackagesto` | Pacchetti modlist (full/incrementali) |
| `/getlatestpackageversion`, `/getgamepackage`, `/getlatestgamepackage` | Versione pacchetto / pacchetto gioco |
| `/latestpackagenewgame`, `/latestpackagenewinstall` | **Distingue nuovo gioco vs reinstall** (full vs delta) |
| `/getlatestinstaller`, `/getlatestinstallerlink`, `/getlatestinstallerversion`, `/getinstaller` | **Auto-update dell'installer** |
| `/getlatestupdaterlink`, `/getlatestupdaterversion` | Auto-update dell'updater |
| `/getinstalledinstance`, `/getinstalledinstances`, `/setinstalledinstance` | Stato istanze installate lato server |
| `/validatelogin` | Login/validazione credenziali |

Header: `Authorization: Bearer <token>`, `Content-Type: application/json`.

## Modello dati (proprietà DTO rilevanti)
- **Version**: `Version`, `IsBeta`/`Beta`, `Maintenance`, `MaintenanceReason`, `LastUpdate`.
- **Variant**: `Name`, `Description`, `Code`, `Image`, `Active`.
- **Requirement** (min/raccomandati): `MinCPU`/`MaxCPU`, `MinGPU`/`MaxGPU`, `MinRAM`/`MaxRAM`, `MinVRAM`/`MaxVRAM`.
- **GPU**: `GPUIndex`, `GPUName`, `GPUVendor`, `GPUVram`.
- **Package**: `DownloadLink`, `DownloadSize`, `InstallLink`, `InstallationSize`,
  `ArchiveStorageSpace`, `ModsStorageSpace`, `NewGame`, `IsCompleted`, `InstallDate`.
- **Contenuti modlist** (stat/flag): `Cities`, `Lods`, `Textures`, `Trees`, `SREX`.
- **Installer/Updater self-update**: `InstallerVersion`, `UpdaterVersion`, `UpdaterHash`,
  `UpdaterLink`, `UpdateLink`, `DownloadLink`, `DevLink`.
- **Errori**: `Error`, `ExceptionMessage`, `ExceptionType`, `StackTrace`, `ServerException`, `StatusCode`.

## Cosa abbiamo applicato
- **Pre-flight spazio disco** (`electron/install/diskSpace.ts`): ispirato a
  `DownloadSize`/`InstallationSize`/`ModsStorageSpace`. Prima di estrarre un archivio
  multi-GB, stimiamo l'ingombro (fattore di espansione + margine) e blocchiamo se il
  volume mod non ha spazio — fail-open su probe non leggibili. Cablato in `installManager`.

## Cosa NON abbiamo (e perché)
- **Chiamate all'API Nolvus**: proprietaria, auth-gated sul loro server → fuori scope/ToS.
  Noi usiamo catalogo delta **firmato in proprio** (Ed25519) + Nexus per i singoli mod.
- **Requisiti hardware / GPU gating**: nessun dato requisiti nel nostro catalogo; possibile
  estensione futura (rilevare VRAM/RAM e confrontare con soglie della modlist).
- **Token Bearer con refresh**: usiamo la API key personale Nexus (statica, header `apikey`),
  niente login/refresh; il supporto `Authorization: Bearer` è comunque già presente nel client.

## Spunti per la roadmap (validati da questo confronto)
- Distinzione **full vs incrementale** (`newgame` vs `newinstall`) ↔ il nostro delta engine.
- **Auto-update dell'app** firmato ↔ riuso del nostro motore delta/manifest per l'updater.
- **Pre-flight requisiti hardware** (GPU/VRAM/RAM) come estensione della pagina Compatibilità.
