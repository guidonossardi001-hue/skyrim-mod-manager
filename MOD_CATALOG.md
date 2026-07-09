# MOD_CATALOG

> Riferimento del catalogo mod locale (Skyrim AE — Anime/Fantasy Edition). Sorgente dati: `src/data/modlistCatalog.ts` (seedato in `modlist_catalog`). Ultimo aggiornamento: 2026-06-23.

## Sintesi
- **103 mod** catalogate · **53 essenziali** (`required: 1`) · **12 con traduzione IT** (`has_it_translation: 1`).
- Target hardware riferimento: RX 9070 XT · Ryzen 7 7800X3D · 16 GB DDR5 · 1080p 60+ FPS · ~200–250 GB.

## Ripartizione per categoria (top-level)
| Categoria | # | Categoria | # |
|---|---|---|---|
| character | 19 | ui | 4 |
| visuals | 14 | performance | 4 |
| framework | 14 | patch | 4 |
| npc | 9 | adult | 4 |
| animation | 9 | translation | 3 |
| gameplay | 8 | world | 2 |
| combat | 6 | audio | 2 |
|  |  | quest | 1 |

(Sottocategorie aggiuntive: engine, body, face, skin, magic, hair, enb, physics, ecc.)

## Schema catalogo (`modlist_catalog`)
Campi base (`CatalogMod` in `src/types/index.ts`):
`id, nexus_id (UNIQUE), name, category, subcategory, priority_order, required, description, author, tags, size_mb, has_it_translation, notes, conflicts_with, requires`.

**Enrichment persistente (migrazione v3):**
`source, collection_id, sha256, last_verified, nexus_mod_id, nexus_file_id, nexus_version, nexus_last_check, nexus_download_url, nexus_dependencies, nexus_endorsement_state, nexus_category`.

## Mappa "catalogo persistente" richiesto → posizione reale
| Campo richiesto | Dove vive |
|---|---|
| mod_name / mod_id / nexus_id | `modlist_catalog.name` / `.id` / `.nexus_id` |
| collection_id / source / sha256 | `modlist_catalog.collection_id` / `.source` / `.sha256` (v3) |
| version | `modlist_catalog.nexus_version` (catalogo) · `mods.version` (installato) |
| dependencies / optional | `modlist_catalog.requires` · `.nexus_dependencies` (v3) · `required` (0/1) |
| installed / enabled / profile | **`mods`** (`is_installed`, `is_enabled`, `profile_id`) — stato per-profilo |
| last_verified | `modlist_catalog.last_verified` (v3) |

> Il catalogo è **profile-independent**; lo stato installato/abilitato per profilo vive nella tabella `mods`. La release versionata per il delta vive in `catalog_release` + `catalog_release_mod` (identità di file: `file_id`, `file_hash`, `version`).

## Ordine d'installazione consigliato
`Framework → Bug Fix → Corpo/Skin → NPC → Grafica → Combat → Gameplay → Animazioni → UI → Adult → Patch` (guida `priority_order`).

## Risoluzione dipendenze
`src/lib/dependencies.ts` (`resolveInstallPlan`): risolve transitivamente `requires`, scarta gli installati, ordina per `priority_order` (framework prima). Cycle-safe. Coperto da test.

## Come estendere il catalogo
1. Aggiungere voci in `src/data/modlistCatalog.ts` (rispettare `CatalogMod`).
2. Il renderer fa seed via `catalog:seed` (upsert su `nexus_id`).
3. Per i delta: produrre un **manifest firmato** (`scripts/sign_manifest.py`) con `file_id`/`file_hash`/`version` per mod → `catalog_release_mod`.
4. Aggiornare `last_verified`/`sha256` quando si verifica l'integrità (provider Nexus, quando attivo).

## Note compatibilità
L'analizzatore (`src/lib/compatibility.ts`) usa `requires`, le categorie e i plugin per segnalare: dipendenze mancanti, SKSE/Address Library, version drift, limite load-order 254 (ESL esclusi), advisory xEdit.
