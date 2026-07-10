# Skyrim AE Fantasy Launcher — Release v1.0.0

## File da allegare alla GitHub Release (tutti e 3, dalla cartella `release/`)
1. `Skyrim-AE-Fantasy-Launcher-Setup-1.0.0.exe` — installer NSIS (89.7 MB)
2. `latest.yml` — feed auto-update (electron-updater lo legge per rilevare nuove versioni)
3. `Skyrim-AE-Fantasy-Launcher-Setup-1.0.0.exe.blockmap` — update differenziali

> ⚠️ Vanno caricati **tutti e tre** e con **questi nomi esatti**: electron-updater legge `latest.yml`, che al suo interno referenzia installer e blockmap per nome + `sha512` + `size`. **Non copiare lo `sha512` altrove**: cambia ad ogni `npm run electron:build`. Fonte di verità = `release/latest.yml`; carica i 3 file **rigenerati insieme** dallo stesso build (devono essere coerenti fra loro).

## Passi (manuali, richiedono il tuo login GitHub)
1. Codice e tag **già pubblicati**: commit `dc5d5d2` su `main`, tag `v1.0.0` già su `origin`, CI verde. Nessuna azione git necessaria.
2. Su GitHub → repo `guidonossardi001-hue/skyrim-mod-manager` → **Releases** → **Draft a new release**.
3. **Tag:** `v1.0.0` (deve combaciare con `version` in package.json — electron-updater richiede il prefisso `v`).
4. **Title:** `Skyrim AE Fantasy Launcher v1.0.0`
5. Trascina i **3 file** sopra nell'area allegati.
6. Incolla le note qui sotto → **Publish release**.

Da questo momento l'auto-update è vivo: al prossimo bump di `version` in `package.json` + nuova release con tag `vX.Y.Z`, i client installati la rileveranno da soli.

---

## Note di rilascio (v1.0.0)

**Prima release del launcher desktop One-Click Play.** L'app diventa l'unico punto d'accesso alla versione moddata di Skyrim AE — niente più avvio manuale di Skyrim vanilla.

### Novità
- **Launcher Fantasy** stile Nolvus come schermata unica: doppio click → **GIOCA** → tutto automatico.
- **Pipeline di avvio a 11 stadi** con checklist live: aggiornamenti launcher → configurazione → dipendenze → installazione → Steam → ambiente moddato → plugin → profilo → integrità → bootstrap → gioco.
- **Integrazione Steam attiva**: se Steam è chiuso lo avvia, attende l'inizializzazione e verifica il login prima di procedere. Overlay/achievement/playtime preservati (nessun bypass).
- **Bootstrapper modulare**: SKSE (primario) → Mod Organizer 2 → DragonLoader (fallback `steam://run`). Sostituibile senza toccare il resto.
- **Smart Startup**: ricorda l'ultima configurazione; opzione avvio automatico a zero click.
- **Auto-update** via GitHub (electron-updater).

### Installazione
Esegui l'installer. **SmartScreen** mostrerà "editore sconosciuto" (l'installer non è firmato con certificato) → *Ulteriori informazioni* → *Esegui comunque*. Crea i collegamenti su Desktop e Menu Start.

### Note tecniche
- Per-utente (nessun privilegio admin). I dati (profili/config) restano in `%APPDATA%\skyrim-ae-mod-manager` e sono preservati agli aggiornamenti e alla disinstallazione.
- Windows x64. Richiede Steam + Skyrim Special/Anniversary Edition + SKSE64.
