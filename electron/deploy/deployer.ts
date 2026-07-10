import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  linkSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'fs'
import { join, dirname } from 'path'
import type { SqliteDb } from '../db/sqlite'
import { columnExists } from '../db/sqlite'
import { toLongPath, listFilesRel } from '../install/extract'
import { sameVolume } from '../install/stockGame'
import { computeDeployPlan, buildPluginsTxt, toDeployCategory, type DeployMod } from './plan'
import { applyIniSettings, mergeIniMaps, managedFileCount, type IniFileMap } from '../ini/iniService'
import { resolveIniTemplate, MOD_REQUIRED_OVERRIDES } from '../ini/templates'
import { detectCreationClub, ccFiles, ccPluginOrder } from './ccHandler'

// Virtualization layer (Nolvus-style). Populates a PROFILE INSTANCE's Data folder
// (e.g. profiles/NolvusAscension/Data) from the deployed mod folders under modsRoot,
// WITHOUT ever touching those sources. It builds the priority override map, links
// files in (hardlinks + block junctions), and writes the instance plugins.txt.
//
// Read-only guarantee on the sources: hardlinks and junctions are extra directory
// entries — removing them (cleanup) unlinks only the name in the instance, never
// the inode/target under modsRoot. The StockGame vanilla Data stays 100% pristine.

export type DeployErrorKind =
  | 'no-mods'
  | 'cross-volume' // hardlinks can't span volumes → refuse before touching anything
  | 'source-missing'
  | 'cleanup'
  | 'link'
  | 'db'

export interface DeployResult {
  success: boolean
  instanceDataDir?: string
  modsLinked?: number
  filesHardlinked?: number
  junctionsCreated?: number
  pluginsWritten?: number
  pluginsPath?: string
  iniFilesWritten?: number
  ccFilesLinked?: number // Creation Club "System DLC" files hardlinked into the instance
  errorKind?: DeployErrorKind
  error?: string
}

export interface DeployProgress {
  stage: 'scanning' | 'cleaning' | 'linking' | 'plugins' | 'ini' | 'done'
  currentMod?: string
  currentFile?: string
  processedItems?: number
  totalItems?: number
  percent?: number
}

export interface DeployOptions {
  profileId?: number // limit to one profile's mods (default: all enabled+installed)
  onProgress?: (p: DeployProgress) => void
  log?: (level: 'info' | 'warn', msg: string) => void
  iniTemplate?: string // quality preset name (ultra/performance/vr); defaults to clean base
  iniOverrides?: IniFileMap // extra mod-required INI keys, merged over the built-in set
  skipIni?: boolean // opt out of INI management entirely (default: apply)
  stockGameDataDir?: string // base-game Data folder to scan for Creation Club content
}

// Throttle the linking phase so a 100k-file deploy doesn't flood the IPC channel:
// emit on the first item, every N items, and the last.
const LINK_EMIT_EVERY = 100

interface ModRow {
  name: string
  priority: number
  install_path: string
  deploy_category?: string | null
  resolution_weight?: number | null
}

/**
 * Safe cleanup of a previous deploy: remove ONLY links (junctions/symlinks and
 * hardlinked files) from the instance, recursing real directories. A symlink is
 * removed as a link (never recursed into — that would reach the source). A file
 * with nlink > 1 is one of our hardlinks: unlinking the instance name leaves the
 * modsRoot source intact. Genuine unique files (nlink === 1, e.g. user configs)
 * are preserved.
 */
function cleanInstanceLinks(dir: string): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(toLongPath(dir), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    let st: import('fs').Stats
    try {
      st = lstatSync(toLongPath(abs))
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      // Junction/symlink → drop the reparse point only. NEVER recursive (that could
      // delete through the link into the source).
      try {
        rmSync(toLongPath(abs), { recursive: false, force: true })
      } catch {
        try {
          unlinkSync(toLongPath(abs))
        } catch {
          /* best effort */
        }
      }
    } else if (st.isDirectory()) {
      cleanInstanceLinks(abs)
      try {
        rmdirSync(toLongPath(abs)) // remove if it became empty; keep if user files remain
      } catch {
        /* not empty → leave it */
      }
    } else if (st.nlink > 1) {
      try {
        unlinkSync(toLongPath(abs)) // our hardlink → source under modsRoot untouched
      } catch {
        /* best effort */
      }
    }
    // nlink === 1 regular file → a genuinely-owned file, preserved.
  }
}

export async function deployInstance(
  db: SqliteDb,
  instanceDataDir: string,
  opts: DeployOptions = {},
): Promise<DeployResult> {
  const log = opts.log ?? (() => {})
  const emit = opts.onProgress ?? (() => {})
  try {
    // 1) Enabled + installed mods with a deployed folder, in priority order.
    const where = ['is_enabled=1', 'is_installed=1', 'install_path IS NOT NULL']
    const params: unknown[] = []
    if (opts.profileId != null) {
      where.push('profile_id=?')
      params.push(opts.profileId)
    }
    // Conflict-resolution columns (migration v8) are selected only when present, so
    // the deployer still runs against a pre-v8 / partial schema (falls back to priority).
    const hasMeta = columnExists(db, 'mods', 'deploy_category')
    const cols = `name, priority, install_path${hasMeta ? ', deploy_category, resolution_weight' : ''}`
    const rows = db
      .prepare(
        `SELECT ${cols} FROM mods WHERE ${where.join(' AND ')} ORDER BY priority ASC, name ASC`,
      )
      .all(...params) as ModRow[]

    if (rows.length === 0) return { success: false, errorKind: 'no-mods', error: 'nessuna mod abilitata da distribuire' }

    // 1.5) Detect Creation Club "System DLC" content in the base-game Data (read-only,
    // graceful: a legacy game without CC yields an empty list). It is hardlinked at a
    // fixed priority right after the official DLCs; a same-named mod file (a CC patch)
    // still wins the file, and the CC plugins are forced into the load order below.
    const ccPackages = detectCreationClub(opts.stockGameDataDir)
    const ccList = ccFiles(ccPackages)

    // 2) Cross-volume guard (hardlinks cannot span drive letters).
    for (const r of rows) {
      if (!sameVolume(r.install_path, instanceDataDir)) {
        return {
          success: false,
          errorKind: 'cross-volume',
          error: `mod "${r.name}" (${r.install_path}) è su un volume diverso dall'istanza (${instanceDataDir}); gli hardlink richiedono lo stesso volume`,
        }
      }
    }

    // 3) Scan each mod's tree; a missing source folder is a hard error.
    const mods: DeployMod[] = []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (!existsSync(r.install_path))
        return { success: false, errorKind: 'source-missing', error: `cartella mod assente: ${r.install_path}` }
      mods.push({
        name: r.name,
        priority: r.priority,
        rootDir: r.install_path,
        files: listFilesRel(r.install_path),
        // Real auto-resolution metadata → computeDeployPlan picks conflict winners
        // by category/weight, not just priority. NULL/unknown falls back to defaults.
        category: toDeployCategory(r.deploy_category),
        resolutionWeight: typeof r.resolution_weight === 'number' ? r.resolution_weight : undefined,
      })
      emit({
        stage: 'scanning',
        currentMod: r.name,
        processedItems: i + 1,
        totalItems: rows.length,
        percent: Math.round(((i + 1) / rows.length) * 100),
      })
    }

    const plan = computeDeployPlan(mods)

    // 4) Safe cleanup of the previous session's links (sources never touched).
    emit({ stage: 'cleaning' })
    try {
      if (existsSync(instanceDataDir)) cleanInstanceLinks(instanceDataDir)
      mkdirSync(toLongPath(instanceDataDir), { recursive: true })
    } catch (e) {
      return { success: false, errorKind: 'cleanup', error: (e as Error).message }
    }

    // 5) Apply: block junctions first, then individual hardlinks. Progress is
    // throttled (first / every N / last) so a huge deploy never floods IPC.
    let junctionsCreated = 0
    let filesHardlinked = 0
    const totalLinks = plan.junctions.length + plan.hardlinks.length
    let processed = 0
    const emitLinking = (currentFile: string) => {
      processed++
      if (processed === 1 || processed === totalLinks || processed % LINK_EMIT_EVERY === 0) {
        emit({
          stage: 'linking',
          currentFile,
          processedItems: processed,
          totalItems: totalLinks,
          percent: totalLinks ? Math.round((processed / totalLinks) * 100) : 100,
        })
      }
    }
    try {
      for (const j of plan.junctions) {
        const dest = join(instanceDataDir, j.dir)
        mkdirSync(toLongPath(dirname(dest)), { recursive: true })
        symlinkSync(j.src, dest, 'junction') // Windows directory junction (absolute target)
        junctionsCreated++
        emitLinking(j.dir)
      }
      for (const h of plan.hardlinks) {
        const dest = join(instanceDataDir, h.rel)
        mkdirSync(toLongPath(dirname(dest)), { recursive: true })
        linkSync(toLongPath(h.src), toLongPath(dest))
        filesHardlinked++
        emitLinking(h.rel)
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const kind: DeployErrorKind = code === 'EXDEV' ? 'cross-volume' : 'link'
      return { success: false, errorKind: kind, error: (e as Error).message }
    }

    // 5.5) Creation Club: hardlink each System-DLC file UNLESS a mod already provides
    // that exact name (a CC-specific patch — the mod wins). Graceful & source-immaculate:
    // linkSync adds a new directory entry to the SAME inode (never a copy, source never
    // modified), and a per-file failure (e.g. EXDEV cross-volume) is logged and skipped
    // rather than failing an otherwise-valid deploy.
    let ccFilesLinked = 0
    if (ccList.length) {
      const modDest = new Set(plan.hardlinks.map((h) => h.rel.toLowerCase()))
      for (const f of ccList) {
        if (modDest.has(f.rel.toLowerCase())) continue // a mod patch overrides this CC file
        const dest = join(instanceDataDir, f.rel)
        try {
          mkdirSync(toLongPath(dirname(dest)), { recursive: true })
          linkSync(toLongPath(f.src), toLongPath(dest))
          ccFilesLinked++
        } catch (e) {
          log('warn', `CC "${f.rel}" non collegato (saltato): ${(e as Error).message}`)
        }
      }
    }

    // 6) Instance plugins.txt (profile dir, sibling of Data). CC plugins are forced
    // right after the base masters/DLCs, ahead of every mod plugin.
    emit({ stage: 'plugins' })
    const pluginsPath = join(dirname(instanceDataDir), 'plugins.txt')
    let pluginsWritten = 0
    try {
      const txt = buildPluginsTxt(plan.plugins, ccPluginOrder(ccPackages))
      mkdirSync(toLongPath(dirname(pluginsPath)), { recursive: true })
      writeFileSync(pluginsPath, txt, 'utf8')
      pluginsWritten = plan.plugins.length
    } catch (e) {
      return { success: false, errorKind: 'link', error: `scrittura plugins.txt fallita: ${(e as Error).message}` }
    }

    // 7) Per-instance INI: overlay the quality template + mod-required keys onto the
    // profile's Skyrim.ini / SkyrimPrefs.ini WITHOUT clobbering user customizations.
    // Non-fatal: the atomic write leaves any prior file intact on failure, and a valid
    // deploy of the links/plugins should not be reported as failed over an INI hiccup.
    let iniFilesWritten = 0
    if (!opts.skipIni) {
      emit({ stage: 'ini' })
      const profileDir = dirname(instanceDataDir)
      const template = resolveIniTemplate(opts.iniTemplate)
      const overrides = mergeIniMaps(MOD_REQUIRED_OVERRIDES, opts.iniOverrides)
      try {
        await applyIniSettings(profileDir, template, overrides)
        iniFilesWritten = managedFileCount(template, overrides)
      } catch (e) {
        log('warn', `applicazione INI fallita (deploy comunque completato): ${(e as Error).message}`)
      }
    }

    emit({ stage: 'done', processedItems: totalLinks, totalItems: totalLinks, percent: 100 })
    log(
      'info',
      `deploy istanza ${instanceDataDir}: ${mods.length} mod, ${filesHardlinked} hardlink, ${junctionsCreated} junction, ${ccFilesLinked} CC, ${pluginsWritten} plugin, ${plan.resolvedConflicts.length} conflitti auto-risolti, ${iniFilesWritten} INI`,
    )
    return {
      success: true,
      instanceDataDir,
      modsLinked: mods.length,
      filesHardlinked,
      junctionsCreated,
      pluginsWritten,
      pluginsPath,
      iniFilesWritten,
      ccFilesLinked,
    }
  } catch (e) {
    return { success: false, errorKind: 'db', error: (e as Error).message }
  }
}
