# Integrazione Nexus Mods — Deferred Activation

> Stato: **IMPLEMENTATO + TESTATO, DISATTIVO** (mock provider attivo finché non si fornisce la chiave API reale).

L'app è **completamente funzionante senza Nexus**: un provider mock serve dati offline/demo. Quando la chiave reale è disponibile e `NEXUS_ENABLED=true`, il provider HTTP si attiva **automaticamente, senza modifiche al codice**.

## Architettura

```
NexusProvider (interfaccia)         electron/nexus/types.ts
 ├─ MockNexusProvider               electron/nexus/mockProvider.ts   (offline, sempre attivo)
 └─ HttpNexusProvider               electron/nexus/httpProvider.ts   (reale, attivato dalla factory)
createNexusProvider(db, cfg)        electron/nexus/index.ts          (factory deferred-activation)
NexusCache (TTL + ETag)             electron/nexus/cache.ts          (SQLite, offline-safe)
```

`createNexusProvider` ritorna `HttpNexusProvider` **solo se** `NEXUS_ENABLED=true` **e** una chiave valida è presente; altrimenti `MockNexusProvider`. Risolto per-chiamata in `main.ts` → toggle senza riavvio.

## Configurazione (`.env`, vedi `.env.example`)
```
NEXUS_API_KEY=
NEXUS_ENABLED=false        # → true per attivare
```
**Sicurezza:** la chiave **non** va mai nel repo. In produzione si preferisce lo store cifrato del SO (`safeStorage`, già usato per `settings.nexusApiKey`); `.env` è per dev/CI.

## Capacità del provider
`getMod(modId)` · `searchByName(query)` · `getFiles(modId)` · `getLatestVersion(modId)` · `checkUpdate(modId, version)`.

## Caching (HTTP)
- Cache SQLite `nexus_cache(key, etag, body, fetched_at, ttl_ms)` (migrazione 3).
- **TTL** configurabile (default 6h) · **ETag** revalidation (`If-None-Match` → 304 = `touch`) · **retry** con backoff su **429** (rate limit) · **offline mode** (fallback su entry stale a qualsiasi errore di rete).

## Catalogo persistente (estensione `modlist_catalog`, migrazione 3)
`source`, `collection_id`, `sha256`, `last_verified`, `nexus_mod_id`, `nexus_file_id`, `nexus_version`, `nexus_last_check`, `nexus_download_url`, `nexus_dependencies`, `nexus_endorsement_state`, `nexus_category`.

## IPC esposti (`window.api.nexus`)
`status()` → `{kind:'mock'|'http', enabled}` · `meta(modId)` · `checkUpdate(modId, version)`.

## Test
`electron/nexus/nexus.test.ts` (8): cache TTL/ETag/upsert/offline-stale; mock metadata/search/update; factory mock-vs-http. Il path HTTP reale richiede chiave+rete (non eseguibile in CI headless) ma è disabled-safe e strutturato.

## Attivazione (quando arriva la chiave)
1. Inserire la chiave in `settings.nexusApiKey` (cifrata) **o** `NEXUS_API_KEY` (.env).
2. `NEXUS_ENABLED=true`.
3. Nessun'altra modifica: ricerca/metadata/aggiornamenti passano al provider HTTP.
