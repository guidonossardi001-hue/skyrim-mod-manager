import { ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import type { SqliteDb } from '../db/sqlite'
import { extractArchive } from '../install/extract'
import { expectedModDirName } from '../catalog/missingFiles'
import {
  parseCollectionManifest,
  indexChoices,
  type CollectionModChoices,
  type ParsedCollectionManifest,
} from './collectionChoices'
import {
  hasFomod,
  fomodApplied,
  runFomodHeadless,
  applyFomodInstructions,
  type FomodContext,
  type FomodPreset,
} from './fomodApply'

// IPC del flusso FOMOD: fetch delle scelte del curatore (archivio revision → collection.json)
// + applicazione headless a tutte le mod estratte flat. Stesso pattern degli altri *engine.ts.

export interface FomodEngineOptions {
  db: SqliteDb
  resolveModsRoot: () => string
  resolveChoicesDir: () => string // userData/collection-manifest
  getApiKey: () => string | undefined
  getCollectionRef: () => { slug: string | null; revision: number | null }
  fetchRevisionDownloadLink: (slug: string, revision: number | null, apiKey: string) => Promise<string>
  // Senza apiKey di proposito: l'URI del CDN è già firmato e la chiave non deve lasciare
  // api.nexusmods.com (stessa regola di streamToFile per i download delle mod).
  downloadToFile: (url: string, destPath: string) => Promise<void>
  bundled7zaPath?: string
  full7zPath?: string
  gameVersion: () => string
  skseVersion: () => string
  onProgress?: (p: { done: number; total: number; current: string }) => void
  log?: (level: 'info' | 'warn', msg: string) => void
}

const CHOICES_CACHE = 'collection-choices.json'

export function initFomodEngine(opts: FomodEngineOptions) {
  const choicesCachePath = () => join(opts.resolveChoicesDir(), CHOICES_CACHE)

  // Le scelte del curatore sono PER FILE (un mod multi-file ha scelte diverse per file):
  // il fileId di una cartella estratta si ricava dalla riga downloads che l'ha creata
  // (stesso schema nome `<nexus_id>-<nome sanificato>`), col modId dal prefisso come
  // fallback per le cartelle nate fuori dalla coda (es. massSync).
  const dirFileIdMap = (): Map<string, number> => {
    const map = new Map<string, number>()
    try {
      const rows = opts.db
        .prepare(
          'SELECT nexus_id, file_id, name FROM downloads WHERE nexus_id IS NOT NULL AND file_id IS NOT NULL',
        )
        .all() as { nexus_id: number; file_id: number; name: string }[]
      for (const r of rows) map.set(expectedModDirName(r.nexus_id, r.name), r.file_id)
    } catch {
      /* schema legacy senza downloads: si resta sul fallback per modId */
    }
    return map
  }

  const choicesForDir = (
    idx: ReturnType<typeof indexChoices> | null,
    byDir: Map<string, number>,
    dir: string,
  ): CollectionModChoices | null => {
    if (!idx) return null
    const fileId = byDir.get(dir)
    if (fileId != null) {
      const hit = idx.byFileId.get(fileId)
      if (hit) return hit
    }
    const modId = Number(dir.split('-')[0])
    return Number.isInteger(modId) ? (idx.byModId.get(modId) ?? null) : null
  }

  const loadCachedManifest = (): ParsedCollectionManifest | null => {
    try {
      if (!existsSync(choicesCachePath())) return null
      return parseCollectionManifest(readFileSync(choicesCachePath(), 'utf8'))
    } catch {
      return null
    }
  }

  // Scarica l'archivio della revision e ne estrae il collection.json (scelte del curatore).
  ipcMain.handle('fomod:fetch-choices', async () => {
    try {
      const apiKey = opts.getApiKey()
      if (!apiKey) return { ok: false as const, error: 'API key Nexus non configurata' }
      const ref = opts.getCollectionRef()
      if (!ref.slug) return { ok: false as const, error: 'Nessuna collection importata (slug ignoto)' }
      const url = await opts.fetchRevisionDownloadLink(ref.slug, ref.revision, apiKey)
      const dir = opts.resolveChoicesDir()
      mkdirSync(dir, { recursive: true })
      const archivePath = join(dir, 'revision-archive.bin')
      await opts.downloadToFile(url, archivePath)
      const outDir = join(dir, 'revision-extracted')
      if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
      await extractArchive(archivePath, outDir, {
        bundled7zaPath: opts.bundled7zaPath,
        full7zPath: opts.full7zPath,
      })
      // collection.json alla radice (o primo trovato in profondità 1).
      let manifestPath = join(outDir, 'collection.json')
      if (!existsSync(manifestPath)) {
        const sub = readdirSync(outDir).find((d) => existsSync(join(outDir, d, 'collection.json')))
        if (sub) manifestPath = join(outDir, sub, 'collection.json')
      }
      if (!existsSync(manifestPath))
        return { ok: false as const, error: "collection.json non trovato nell'archivio della revision" }
      const raw = readFileSync(manifestPath, 'utf8')
      const parsed = parseCollectionManifest(raw)
      if (!parsed) return { ok: false as const, error: 'collection.json malformato' }
      writeFileSync(choicesCachePath(), raw, 'utf8')
      const withChoices = parsed.mods.filter((m) => m.choices?.length).length
      opts.log?.(
        'info',
        `scelte collection scaricate: ${parsed.mods.length} mod nel manifest, ${withChoices} con scelte FOMOD del curatore`,
      )
      return { ok: true as const, mods: parsed.mods.length, withChoices }
    } catch (e) {
      opts.log?.('warn', `fetch scelte collection fallito: ${(e as Error).message}`)
      return { ok: false as const, error: (e as Error).message }
    }
  })

  // Stato: quante mod estratte hanno un FOMOD, quante già applicate, quante con scelte note.
  ipcMain.handle('fomod:scan', () => {
    try {
      const modsRoot = opts.resolveModsRoot()
      const manifest = loadCachedManifest()
      const idx = manifest ? indexChoices(manifest) : null
      const byDir = idx ? dirFileIdMap() : new Map<string, number>()
      const dirs = existsSync(modsRoot)
        ? readdirSync(modsRoot).filter((d) => {
            try {
              return statSync(join(modsRoot, d)).isDirectory()
            } catch {
              return false
            }
          })
        : []
      let total = 0
      let applied = 0
      let withChoices = 0
      for (const d of dirs) {
        const p = join(modsRoot, d)
        // Una mod APPLICATA non ha più la dir fomod/ (rimossa dalla ristrutturazione): il
        // marker è l'unica prova. Contare solo hasFomod() mostrava "0 già applicate" per
        // costruzione — l'insieme {fomod/ presente E marker presente} è vuoto.
        const done = fomodApplied(p)
        if (!done && !hasFomod(p)) continue
        total++
        if (done) applied++
        else if (choicesForDir(idx, byDir, d)?.choices?.length) withChoices++
      }
      return { ok: true as const, total, applied, withChoices, choicesCached: !!manifest }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  // Applica gli installer FOMOD a TUTTE le mod estratte flat non ancora processate.
  ipcMain.handle('fomod:apply-all', async () => {
    try {
      const modsRoot = opts.resolveModsRoot()
      const manifest = loadCachedManifest()
      const idx = manifest ? indexChoices(manifest) : null
      const byDir = idx ? dirFileIdMap() : new Map<string, number>()
      const dirs = readdirSync(modsRoot).filter((d) => {
        try {
          const p = join(modsRoot, d)
          return statSync(p).isDirectory() && hasFomod(p) && !fomodApplied(p)
        } catch {
          return false
        }
      })
      // Plugin noti per le fileDependency dei ModuleConfig: i plugin root di ogni mod estratta.
      const knownPlugins: string[] = []
      for (const d of readdirSync(modsRoot)) {
        try {
          for (const f of readdirSync(join(modsRoot, d))) {
            if (/\.(esp|esm|esl)$/i.test(f)) knownPlugins.push(f)
          }
        } catch {
          /* skip */
        }
      }
      const ctx: FomodContext = {
        gameVersion: opts.gameVersion(),
        skseVersion: opts.skseVersion(),
        knownPlugins,
      }
      const report = {
        processed: 0,
        applied: 0,
        defaultsUsed: 0, // senza scelte del curatore: default dell'autore (preselect)
        unsupported: [] as string[],
        failed: [] as { mod: string; error: string }[],
      }
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i]
        const modDir = join(modsRoot, d)
        opts.onProgress?.({ done: i, total: dirs.length, current: d })
        report.processed++
        const entry = choicesForDir(idx, byDir, d)
        const preset = (entry?.choices ?? []) as FomodPreset
        if (!entry?.choices?.length) report.defaultsUsed++
        const run = await runFomodHeadless(modDir, preset, ctx)
        if (!run.ok) {
          if (!run.supported) report.unsupported.push(d)
          else report.failed.push({ mod: d, error: run.error ?? 'errore ignoto' })
          continue
        }
        const apply = applyFomodInstructions(modDir, run.instructions ?? [], {
          preset,
          message: run.message,
        })
        if (apply.ok) {
          report.applied++
          opts.log?.(
            'info',
            `FOMOD applicato a "${d}": ${apply.filesMapped} file mappati, ${apply.discarded} scartati${entry?.choices?.length ? ' (scelte curatore)' : ' (default autore)'}`,
          )
        } else {
          report.failed.push({ mod: d, error: apply.error ?? 'apply fallito' })
          opts.log?.('warn', `FOMOD NON applicato a "${d}": ${apply.error}`)
        }
      }
      opts.onProgress?.({ done: dirs.length, total: dirs.length, current: '' })
      opts.log?.(
        'info',
        `FOMOD apply-all: ${report.applied}/${report.processed} applicate (${report.defaultsUsed} coi default autore), ${report.unsupported.length} non supportate, ${report.failed.length} fallite`,
      )
      return { ok: true as const, ...report }
    } catch (e) {
      opts.log?.('warn', `fomod:apply-all errore inatteso: ${(e as Error).message}`)
      return { ok: false as const, error: (e as Error).message }
    }
  })
}
