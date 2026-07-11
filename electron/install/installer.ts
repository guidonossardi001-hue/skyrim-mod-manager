import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync, renameSync, readdirSync, statSync } from 'fs'
import { mkdir as mkdirAsync, rename as renameAsync } from 'fs/promises'
import { join, dirname } from 'path'
import type { SqliteDb } from '../db/sqlite'
import { tableExists } from '../db/sqlite'
import {
  planRecipe,
  sevenZipIncludeFilters,
  type InstallInstructions,
  type RecipeMapping,
} from './recipe'
import { extractArchive, toLongPath, verifyArchiveHash, listFilesRel } from './extract'
import { bundled7zaPath, resolveRar7z } from './sevenZip'
import { getFreeSpace, assessDiskSpace, estimateInstallFootprint, formatBytes } from './diskSpace'
import { sanitizePathSegment } from '../util/paths'

// Atomic install orchestrator. Extracts a mod archive into an isolated STAGING
// area on the same NTFS volume as the mods folder, applies the deterministic
// recipe (FOMOD replacement) there, verifies its post-conditions, and only then
// commits with a single terminal rename into <modsRoot>/<modName>. The final mod
// folder is touched by exactly ONE operation — so it appears complete or not at
// all, never half-written. Every failure path cleans up staging and returns an
// InstallResult (no-throw boundary), mapping the cause to an InstallErrorKind.

export type InstallErrorKind =
  | 'not-found' // archive missing
  | 'hash' // pre-extraction integrity mismatch
  | 'disk-space'
  | 'extract' // 7-Zip failure / unsupported format / missing .rar codec
  | 'recipe' // unsatisfiable: nothing matched, or expect post-condition failed
  | 'recipe-slip' // a rule dest resolved outside the mod root (rejected)
  | 'commit' // final rename failed (locked dir / permissions / already exists)
  | 'cancelled'
  | 'db'

export interface InstallProgress {
  nexusId: number
  stage: 'verifying' | 'extracting' | 'mapping' | 'committing' | 'done'
  percent?: number
  currentFile?: string
}

export interface InstallResult {
  success: boolean
  nexusId: number
  modPath?: string
  strategy?: 'root' | 'recipe'
  recipeSource?: 'exact' | 'nexus' | 'default'
  filesDeployed?: number
  method?: '7z' | '7za' | 'zip'
  recipeSchema?: number
  errorKind?: InstallErrorKind
  error?: string
}

export interface InstallOptions {
  signal?: AbortSignal
  onProgress?: (p: InstallProgress) => void
  force?: boolean // reinstall over an existing deployed mod
  modName?: string // final folder name (sanitized); defaults to mod_<nexusId>
  hashAlgo?: 'md5' | 'sha256' // algorithm for the fileHash pre-extraction gate (default sha256)
}

// ── Injectable extractor (real 7-Zip in prod, a fake in tests) ────────────────

export interface ExtractRequest {
  archivePath: string
  destDir: string
  includeFilters?: string[]
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}
export type Extractor = (req: ExtractRequest) => Promise<{ method: '7z' | '7za' | 'zip' }>

/** Production extractor: reuses extractArchive (streaming, atomic, abortable). */
export function defaultExtractor(sevenZipPathSetting?: string | null): Extractor {
  return (req) =>
    extractArchive(req.archivePath, req.destDir, {
      bundled7zaPath: bundled7zaPath(),
      full7zPath: resolveRar7z(sevenZipPathSetting) ?? undefined,
      includeFilters: req.includeFilters,
      onProgress: req.onProgress,
      signal: req.signal,
    })
}

export interface InstallerServiceDeps {
  db: SqliteDb
  modsRoot: () => string
  extract: Extractor
  uuid?: () => string // injectable for deterministic staging in tests
  log?: (level: 'info' | 'warn', msg: string) => void
}

interface RecipeRow {
  file_id: number | null
  file_hash: string | null
  schema_version: number
  strategy: string
  instructions: string
}

interface ResolvedRecipe {
  instructions: InstallInstructions
  schema: number
  source: 'exact' | 'nexus' | 'default'
}

const STAGING_DIRNAME = '.staging'
// Suffix for the previous install moved aside during an atomic reinstall swap.
const REINSTALL_BACKUP_SUFFIX = '.smm-old'

export class InstallerService {
  private uuid: () => string
  constructor(private deps: InstallerServiceDeps) {
    this.uuid = deps.uuid ?? randomUUID
  }
  private log(level: 'info' | 'warn', msg: string) {
    this.deps.log?.(level, msg)
  }

  /**
   * Resolve the recipe for (nexus_id, file_id): exact match first, then any
   * nexus-wide recipe (default file_id NULL preferred), else the built-in 'root'
   * strategy. A file-specific recipe whose file_hash disagrees with the archive is
   * skipped (folders reshuffle across versions — never misplace files).
   */
  private resolveRecipe(nexusId: number, fileId: number | null, fileHash: string | null): ResolvedRecipe {
    const fallbackRoot: ResolvedRecipe = {
      instructions: { schema_version: 0, strategy: 'root' },
      schema: 0,
      source: 'default',
    }
    try {
      if (!tableExists(this.deps.db, 'mod_install_recipe')) return fallbackRoot
      const parse = (row: RecipeRow): InstallInstructions | null => {
        try {
          return JSON.parse(row.instructions) as InstallInstructions
        } catch {
          return null
        }
      }
      if (fileId != null) {
        const exact = this.deps.db
          .prepare('SELECT * FROM mod_install_recipe WHERE nexus_id=? AND file_id=? LIMIT 1')
          .get(nexusId, fileId) as RecipeRow | undefined
        if (exact) {
          const hashOk = !exact.file_hash || !fileHash || exact.file_hash.toLowerCase() === fileHash.toLowerCase()
          const inst = hashOk ? parse(exact) : null
          if (!hashOk)
            this.log('warn', `recipe #${nexusId}/${fileId}: file_hash non combacia con l'archivio, uso fallback`)
          if (inst) return { instructions: inst, schema: exact.schema_version, source: 'exact' }
        }
      }
      const fb = this.deps.db
        .prepare('SELECT * FROM mod_install_recipe WHERE nexus_id=? ORDER BY (file_id IS NULL) DESC, id DESC LIMIT 1')
        .get(nexusId) as RecipeRow | undefined
      if (fb) {
        const inst = parse(fb)
        if (inst) return { instructions: inst, schema: fb.schema_version, source: 'nexus' }
      }
      return fallbackRoot
    } catch (e) {
      this.log('warn', `resolveRecipe fallito, uso 'root': ${(e as Error).message}`)
      return fallbackRoot
    }
  }

  private async placeMapped(
    rawDir: string,
    mappedDir: string,
    mappings: RecipeMapping[],
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdirAsync(mappedDir, { recursive: true })
    for (const m of mappings) {
      if (signal?.aborted) throw new Error('annullato')
      const src = join(rawDir, m.src)
      const dest = join(mappedDir, m.destRel)
      await mkdirAsync(toLongPath(dirname(dest)), { recursive: true })
      // Intra-volume rename: instant metadata move, never a byte copy.
      await renameAsync(toLongPath(src), toLongPath(dest))
    }
  }

  async installMod(
    nexusId: number,
    fileId: number | null,
    fileHash: string | null,
    archivePath: string,
    opts: InstallOptions = {},
  ): Promise<InstallResult> {
    const { signal, onProgress } = opts
    const progress = (stage: InstallProgress['stage'], extra?: Partial<InstallProgress>) =>
      onProgress?.({ nexusId, stage, ...extra })
    const isCancel = (e: unknown) =>
      !!signal?.aborted || /annull|abort/i.test((e as Error)?.message ?? '')

    let stagingDir: string | null = null
    const cleanup = () => {
      if (stagingDir && existsSync(stagingDir)) {
        try {
          rmSync(stagingDir, { recursive: true, force: true })
        } catch {
          /* best effort — a leftover under .staging is swept on next startup */
        }
      }
    }

    try {
      if (signal?.aborted) return this.fail(nexusId, 'cancelled', 'operazione annullata')
      if (!archivePath || !existsSync(archivePath))
        return this.fail(nexusId, 'not-found', `archivio non trovato: ${archivePath}`)

      const recipe = this.resolveRecipe(nexusId, fileId, fileHash)

      // 1) Pre-extraction integrity (stream the archive; reject before touching disk).
      if (fileHash) {
        progress('verifying')
        const v = await verifyArchiveHash(archivePath, fileHash, opts.hashAlgo ?? 'sha256')
        if (!v.ok)
          return this.fail(
            nexusId,
            'hash',
            `hash archivio non corrisponde (atteso ${fileHash.slice(0, 12)}…, ottenuto ${v.actual.slice(0, 12)}…)`,
          )
      }

      // 2) Disk-space pre-flight (fail-open on an unreadable probe).
      const archiveBytes = statSync(archivePath).size
      const free = await getFreeSpace(this.deps.modsRoot())
      const space = assessDiskSpace({ requiredBytes: estimateInstallFootprint(archiveBytes), freeBytes: free })
      if (!space.ok)
        return this.fail(
          nexusId,
          'disk-space',
          `spazio insufficiente: servono ~${formatBytes(space.requiredBytes)}, liberi ${formatBytes(space.freeBytes)}`,
        )

      // 3) Staging under modsRoot ⇒ guaranteed same volume as the final dir.
      const modsRoot = this.deps.modsRoot()
      stagingDir = join(modsRoot, STAGING_DIRNAME, `${nexusId}-${this.uuid()}`)
      const rawDir = join(stagingDir, 'raw')
      const mappedDir = join(stagingDir, 'mapped')
      mkdirSync(rawDir, { recursive: true })

      // 4) Selective extraction: for a recipe, pass 7z include filters so unwanted
      //    variant folders are never unpacked.
      progress('extracting', { percent: 0 })
      const includeFilters =
        recipe.instructions.strategy === 'recipe' ? sevenZipIncludeFilters(recipe.instructions) : []
      let method: '7z' | '7za' | 'zip'
      try {
        const res = await this.deps.extract({
          archivePath,
          destDir: rawDir,
          includeFilters,
          signal,
          onProgress: (percent) => progress('extracting', { percent }),
        })
        method = res.method
      } catch (e) {
        if (isCancel(e)) return this.fail(nexusId, 'cancelled', 'estrazione annullata')
        return this.fail(nexusId, 'extract', (e as Error).message)
      }

      // 5) Map & verify: plan against the extracted tree, then move approved files
      //    into mapped/ via intra-volume renames.
      progress('mapping')
      const files = listFilesRel(rawDir)
      const plan = planRecipe(files, recipe.instructions)
      if (!plan.success || !plan.mappings) {
        const kind: InstallErrorKind = plan.errorKind === 'recipe-slip' ? 'recipe-slip' : 'recipe'
        return this.fail(nexusId, kind, plan.errors?.join('; ') ?? 'recipe non applicabile')
      }
      try {
        await this.placeMapped(rawDir, mappedDir, plan.mappings, signal)
      } catch (e) {
        if (isCancel(e)) return this.fail(nexusId, 'cancelled', 'mapping annullato')
        return this.fail(nexusId, 'recipe', `applicazione recipe fallita: ${(e as Error).message}`)
      }

      // 6) Terminal commit. First install = a single rename of mapped/ into place.
      //    Reinstall (force) = an ATOMIC swap: move the current install aside, rename
      //    the new tree in, then drop the old. On any failure the previous install is
      //    restored untouched — a crash can never leave the mod both un-removed and
      //    un-replaced (the old rm-then-rename could lose it entirely). Windows also
      //    forbids renaming over an existing directory, so moving aside is required.
      progress('committing')
      const modName = sanitizePathSegment(opts.modName ?? `mod_${nexusId}`)
      const finalDir = join(modsRoot, modName)
      const finalExisted = existsSync(finalDir)
      if (finalExisted && !opts.force)
        return this.fail(nexusId, 'commit', `destinazione già presente: ${modName} (usa force per reinstallare)`)
      try {
        if (finalExisted) {
          const backupDir = `${finalDir}${REINSTALL_BACKUP_SUFFIX}`
          if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true })
          renameSync(finalDir, backupDir)
          try {
            renameSync(mappedDir, finalDir)
          } catch (e) {
            try {
              renameSync(backupDir, finalDir) // roll back to the previous install
            } catch {
              /* backup survives on disk → recoverReinstalls restores it at next boot */
            }
            return this.fail(nexusId, 'commit', `commit fallito: ${(e as Error).message}`)
          }
          rmSync(backupDir, { recursive: true, force: true })
        } else {
          renameSync(mappedDir, finalDir)
        }
      } catch (e) {
        return this.fail(nexusId, 'commit', `commit fallito: ${(e as Error).message}`)
      }

      progress('done')
      this.log(
        'info',
        `installato #${nexusId} → ${finalDir} (${recipe.instructions.strategy}/${recipe.source}, ${plan.mappings.length} file, ${method})`,
      )
      return {
        success: true,
        nexusId,
        modPath: finalDir,
        strategy: recipe.instructions.strategy,
        recipeSource: recipe.source,
        filesDeployed: plan.mappings.length,
        method,
        recipeSchema: recipe.schema,
      }
    } catch (e) {
      // Defense-in-depth: nothing above should escape, but the boundary holds regardless.
      if (isCancel(e)) return this.fail(nexusId, 'cancelled', 'operazione annullata')
      return this.fail(nexusId, 'db', (e as Error).message)
    } finally {
      cleanup()
    }
  }

  private fail(nexusId: number, errorKind: InstallErrorKind, error: string): InstallResult {
    this.log('warn', `install #${nexusId} fallito [${errorKind}]: ${error}`)
    return { success: false, nexusId, errorKind, error }
  }
}

/** Startup sweep: discard orphaned staging dirs left by a crash mid-install. */
export function sweepStaging(modsRoot: string): number {
  const root = join(modsRoot, STAGING_DIRNAME)
  if (!existsSync(root)) return 0
  let removed = 0
  for (const name of readdirSync(root)) {
    try {
      rmSync(join(root, name), { recursive: true, force: true })
      removed++
    } catch {
      /* best effort */
    }
  }
  return removed
}

/**
 * Startup recovery for a crash DURING the atomic reinstall swap. A leftover
 * "<mod>.smm-old" means the swap was interrupted:
 *   • "<mod>" missing → the new tree never committed; restore the backup,
 *   • "<mod>" present → the commit succeeded; discard the stale backup.
 */
export function recoverReinstalls(modsRoot: string): number {
  if (!existsSync(modsRoot)) return 0
  let recovered = 0
  for (const name of readdirSync(modsRoot)) {
    if (!name.endsWith(REINSTALL_BACKUP_SUFFIX)) continue
    const backup = join(modsRoot, name)
    const finalDir = join(modsRoot, name.slice(0, -REINSTALL_BACKUP_SUFFIX.length))
    try {
      if (existsSync(finalDir)) rmSync(backup, { recursive: true, force: true })
      else renameSync(backup, finalDir)
      recovered++
    } catch {
      /* best effort */
    }
  }
  return recovered
}
