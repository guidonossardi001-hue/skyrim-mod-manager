# MOD_CATALOG

> Riferimento del sistema di catalogo mod. Ultimo aggiornamento: **2026-07-16**.
>
> **⚠️ Cambiamento sostanziale rispetto alla versione precedente di questo documento:** il seed statico bundlato (`src/data/modlistCatalog.ts`, 103→127 mod) descritto qui prima **non si auto-popola più**. Restava nel codice come dato storico ma la `useEffect` che lo re-inseriva nel DB ad ogni mount della pagina Catalogo è stata **rimossa** (commit `5a0d16d`): causava una regressione ricorrente in cui il catalogo "resuscitava" da solo con `nexus_id` storicamente sbagliati anche dopo uno svuotamento voluto dall'utente.

## Come si popola il catalogo oggi

Il catalogo (`modlist_catalog`) **non ha più alcuna fonte automatica**. Le uniche vie per popolarlo sono azioni esplicite dell'utente in UI:

1. **"Importa Collection Nexus"** (pagina Catalogo) — **fonte primaria consigliata**. Accetta uno slug nudo o un URL pagina collezione (vecchio formato, nuovo formato con `games/`, o `next.nexusmods.com`). Sotto: `electron/nexus/collections.ts` interroga il **GraphQL v2 ufficiale di Nexus** (`collectionRevision(slug, revision)`), ottenendo `modId`/`fileId` **direttamente dalla fonte** — mai stimati, mai da un JSON locale con id storicamente inaffidabili. Ogni riga catalogo importata ha sempre `nexus_file_id` valorizzato → il download è sempre derivabile.
2. **"Aggiorna catalogo"** — ingest del manifest firmato remoto (Ed25519, stessa trust boundary del delta update). Sostituisce l'intero catalogo con la release firmata.
3. **"Importa modlist Vortex"** — presente in UI ma **la sua fonte dati (`data/vortex-collections-backup.json`) è stata eliminata deliberatamente** (su richiesta esplicita dell'utente, 2026-07-16 — nessuna copia esiste più, nemmeno di sicurezza). Il bottone fallisce con grazia ("Backup Vortex non trovato"). Per farlo funzionare di nuovo servirebbe rigenerare il backup da una scansione Vortex live (`vortex:scan`) o da un file fornito dall'utente.
4. **Seed curato bundlato** (`src/data/modlistCatalog.ts`) — il codice e i dati esistono ancora (`catalog:seed` IPC), ma è dietro un guardiano permanente: se `store.get('catalogSeedDisabled') === true` (impostato da ogni wipe), l'IPC rifiuta silenziosamente. **Nessun componente UI lo chiama più automaticamente.** Contiene `nexus_id` **storicamente inaffidabili** (verificato: alcune voci mappano sull'id sbagliato, es. una voce con l'id reale di SkyUI) — non fidarsi per un mapping id→nome senza incrociare con Nexus.

## Svuotamento del catalogo

Bottone **"Svuota catalogo"** (pagina Catalogo) — IPC `catalog:wipe`: cancella `modlist_catalog` + `downloads` + `mods` del profilo in una transazione (figli-prima per i vincoli FK), e imposta `catalogSeedDisabled=true` così nessun seed automatico può ripopolarlo. I file estratti su disco (`data/mods`) **non vengono toccati** da questa azione — serve un'eliminazione separata se si vuole liberare anche quello spazio.

## Schema catalogo (`modlist_catalog`)
Campi base (`CatalogMod` in `src/types/index.ts`):
`id, nexus_id (UNIQUE), nexus_file_id, name, category, subcategory, priority_order, required, description, author, tags, size_mb, has_it_translation, notes, conflicts_with, requires`.

**Colonne conflitti/deploy (migrazione v8):** `deploy_category`, `resolution_weight` — usate dal planner del deploy per decidere il vincitore di una sovrascrittura file (categoria > peso risoluzione > priorità/nome). La pagina Conflitti (`deploy:prefer`) alza il `resolution_weight` della mod scelta dall'utente — mai una disattivazione.

**Enrichment persistente (migrazione v3, storico, ancora presente):** `source, collection_id, sha256, last_verified, nexus_mod_id, nexus_version, nexus_last_check, nexus_download_url, nexus_dependencies, nexus_endorsement_state, nexus_category`.

Il campo `notes` porta un marker di provenienza per ogni riga importata: `"Importato da Nexus Collection \"<nome>\" rev.<N>"` (import Collection) o l'equivalente per import Vortex — utile per capire da dove viene una riga specifica.

## Collezione attualmente in uso (dati reali, 2026-07-16)
- **"Opoal Collection."** — slug `frkafa`, revisione **159**, Total Overhaul NSFW (~1739 mod nella revisione importata; la descrizione del creatore ne cita 1875, la revisione live differisce leggermente).
- Config persistita: `collectionSlug=frkafa`, `collectionRevision=159` (serve al fetch delle scelte FOMOD del curatore, `electron/fomod/engine.ts`).
- Requisiti dichiarati dal creatore: AE DLC + tutti i Creation Club scaricati, texture 1K (profilo performance FHD), contenuto adult (l'account Nexus deve avere l'opzione abilitata).
- Stato installazione: coda download **completata** (1739/1739 dopo il fix del riconoscimento RAR-mascherato-da-.7z), 235 mod con installer FOMOD (ristrutturate col motore Vortex nativo), archivi eliminati dopo install (politica spazio, ~74 GB liberati + 23 GB di estrazioni di vecchie collezioni superate).

## Risoluzione dipendenze
`electron/catalog/dependencies.ts` (`resolveInstallPlan`): risolve transitivamente `requires`, scarta gli installati, ordina per `priority_order`. Cycle-safe, coperto da test. **Nota:** questa è la risoluzione a livello CATALOGO (quali mod scaricare insieme); il load order dei PLUGIN a runtime è un sistema separato e più autoritativo (vedi sotto).

## Load order (separato dal catalogo, non più "LOOT esterno")
Il campo `requires` del catalogo è solo un **fallback** quando l'header binario di un plugin è illeggibile. La fonte di verità per l'ordine di caricamento reale è:
1. `electron/plugins/espParser.ts` — legge i master REALI dal record TES4 di ogni plugin (mai dal catalogo).
2. `electron/plugins/lootSort.ts` + `lootMasterlist.ts` — topo-sort sui master reali, arricchito da una masterlist community reale (scaricata in cache locale via bottone esplicito "Aggiorna masterlist" in Strumenti — non automatico).
3. `electron/deploy/lootOrder.ts` — adapter che alimenta `plugins.txt` con la sequenza calcolata; blocca il deploy (PRIMA di scrivere) su ciclo di dipendenze o master mancanti, e sul superamento del budget di 254 slot plugin "full" (i `.esl`/light hanno uno slot separato da 4096).

## Note compatibilità
L'analizzatore storico (`src/lib/compatibility.ts`) resta per il report generale (SKSE/Address Library/version drift). Per i conflitti FILE reali e la loro risoluzione chirurgica, usare la pagina **Conflitti** (`deploy:preview`/`deploy:prefer`), non questo documento.
