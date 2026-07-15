import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  lstatSync,
  linkSync,
  symlinkSync,
  unlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  copyFileSync,
} from 'fs'
import { join, dirname } from 'path'
import type { SqliteDb } from '../db/sqlite'
import { columnExists } from '../db/sqlite'
import { toLongPath, listFilesRel } from '../install/extract'
import { sameVolume } from '../install/stockGame'
import {
  computeDeployPlan,
  buildPluginsTxt,
  toDeployCategory,
  parseDeployManifest,
  DEPLOY_MANIFEST_FILE,
  VANILLA_BACKUP_SUFFIX,
  type DeployManifest,
  type DeployMod,
} from './plan'
import { orderPluginsLoot } from './lootOrder'
import { loadMasterlist } from '../plugins/masterlist'
import { loadMasterlistCache } from '../plugins/masterlistCache'
import { scanDirtyPlugins } from '../plugins/dirtyPluginCheck'
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
  | 'dependency-cycle' // ciclo nel grafo requires dei plugin → deploy BLOCCATO prima di toccare file
  | 'missing-master' // un plugin richiede un master (header TES4) né deployato né vanilla/CC → crash al load
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
  systemPluginsPath?: string // plugins.txt di sistema (%LOCALAPPDATA%) quando scritto
  iniFilesWritten?: number
  ccFilesLinked?: number // Creation Club "System DLC" files hardlinked into the instance
  conflictsResolved?: number // file collisions auto-risolte dal planner (audit nel log)
  dirtyPlugins?: { plugin: string; itm: number; udr: number; nav: number; util: string }[] // vedi dirtyPluginCheck
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
  // Cartella del plugins.txt DI SISTEMA (%LOCALAPPDATA%/Skyrim Special Edition): il gioco legge il
  // load order da lì quando NON si passa da MO2. Opzionale/iniettata; se assente si scrive solo la
  // copia d'istanza. Il file preesistente dell'utente viene salvato UNA volta in plugins.txt.pre-smm.bak.
  systemPluginsDir?: string
  // Masterlist-lite opzionale (regole "after" LOOT-like): path del masterlist.json in userData.
  // Regole SOFT: ordinano quando possibile, scartate con warning su ciclo, mai un blocco.
  masterlistPath?: string
  // Cache del masterlist LOOT reale (fetch esplicita via masterlist:refresh, mai automatica —
  // il deploy legge SOLO questa cache locale, mai la rete). Assente = nessuna regola/rank/dirty
  // aggiuntivi, comportamento identico a prima dell'integrazione LOOT.
  lootMasterlistCachePath?: string
  // false = MAI pulizia euristica (nlink) senza manifest. OBBLIGATORIO false quando il target è
  // la Data del GIOCO REALE: l'euristica è pensata per un'istanza dedicata, su una Data condivisa
  // potrebbe toccare file non nostri. Default true (retro-compatibile con le istanze).
  allowHeuristicCleanup?: boolean
}

// Throttle the linking phase so a 100k-file deploy doesn't flood the IPC channel:
// emit on the first item, every N items, and the last.
const LINK_EMIT_EVERY = 100

interface ModRow {
  name: string
  priority: number
  install_path: string
  nexus_id?: number | null
  deploy_category?: string | null
  resolution_weight?: number | null
}

/** Grafo `requires` del catalogo (nexus_id → deps). Vuoto se tabella assente/malformata. */
function catalogRequires(db: SqliteDb): Map<number, number[]> {
  const map = new Map<number, number[]>()
  try {
    const rows = db.prepare('SELECT nexus_id, requires FROM modlist_catalog').all() as Array<{
      nexus_id: number
      requires: string | null
    }>
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.requires ?? '[]')
        if (Array.isArray(arr)) {
          const deps = arr.map(Number).filter((n) => Number.isInteger(n) && n > 0)
          if (deps.length) map.set(r.nexus_id, deps)
        }
      } catch {
        /* riga malformata → nessun vincolo */
      }
    }
  } catch {
    /* catalogo assente → ordine per sola priorità */
  }
  return map
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

export interface PurgeResult {
  success: boolean
  manifestFound: boolean
  filesRemoved: number
  junctionsRemoved: number
  dirsPruned: number
  skipped: number // voci del manifest NON rimosse (sostituite dall'utente: nlink=1 → preservate)
  systemPluginsRestored: boolean
  error?: string
}

/**
 * Purge ESATTO guidato dal manifest: rimuove solo ciò che il deployer ha registrato di aver
 * creato. Difese: una junction si rimuove solo se lstat la vede come reparse point; un file solo
 * se nlink > 1 (ancora un nostro hardlink) — un file rimpiazzato dall'utente (nlink=1) si
 * PRESERVA e si conta in `skipped`. Le directory rimaste vuote vengono potate bottom-up. Il
 * plugins.txt di sistema viene ripristinato dal backup .pre-smm.bak se presente.
 */
function purgeByManifest(
  instanceDataDir: string,
  log: (level: 'info' | 'warn', msg: string) => void,
): PurgeResult {
  const res: PurgeResult = {
    success: true,
    manifestFound: false,
    filesRemoved: 0,
    junctionsRemoved: 0,
    dirsPruned: 0,
    skipped: 0,
    systemPluginsRestored: false,
  }
  const manifestPath = join(instanceDataDir, DEPLOY_MANIFEST_FILE)
  let manifest: DeployManifest | null = null
  try {
    if (existsSync(manifestPath)) manifest = parseDeployManifest(readFileSync(manifestPath, 'utf8'))
  } catch {
    manifest = null
  }
  if (!manifest) return res
  res.manifestFound = true

  const parentDirs = new Set<string>()
  for (const rel of manifest.files) {
    const abs = join(instanceDataDir, rel)
    try {
      const st = lstatSync(toLongPath(abs))
      if (st.isFile() && st.nlink > 1) {
        unlinkSync(toLongPath(abs))
        res.filesRemoved++
      } else if (st.isFile()) {
        res.skipped++ // l'utente ha sostituito il file con una copia propria: si preserva
      }
    } catch {
      /* già assente */
    }
    let d = dirname(rel)
    while (d && d !== '.') {
      parentDirs.add(d)
      d = dirname(d)
    }
  }
  for (const dir of manifest.junctions) {
    const abs = join(instanceDataDir, dir)
    try {
      const st = lstatSync(toLongPath(abs))
      if (st.isSymbolicLink()) {
        try {
          rmSync(toLongPath(abs), { recursive: false, force: true })
        } catch {
          unlinkSync(toLongPath(abs))
        }
        res.junctionsRemoved++
      }
    } catch {
      /* già assente */
    }
    const p = dirname(dir)
    if (p && p !== '.') parentDirs.add(p)
  }
  // Ripristina gli ORIGINALI preesistenti sostituiti dal deploy (target = Data del gioco
  // reale): il file mod è già stato rimosso sopra, il `.smm-vanilla.bak` torna al suo nome.
  for (const rel of manifest.backups ?? []) {
    const abs = join(instanceDataDir, rel)
    const bak = abs + VANILLA_BACKUP_SUFFIX
    try {
      if (existsSync(bak) && !existsSync(abs)) renameSync(toLongPath(bak), toLongPath(abs))
      else if (existsSync(bak)) unlinkSync(toLongPath(bak)) // il posto è già rioccupato: il bak è residuo
    } catch (e) {
      log('warn', `ripristino originale "${rel}" fallito: ${(e as Error).message}`)
    }
  }
  // Pota le directory rimaste vuote, dalle più profonde.
  const byDepth = [...parentDirs].sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)
  for (const d of byDepth) {
    try {
      rmdirSync(toLongPath(join(instanceDataDir, d))) // fallisce se non vuota → la si lascia
      res.dirsPruned++
    } catch {
      /* non vuota o assente */
    }
  }
  // Ripristina il plugins.txt di sistema dell'utente, se avevamo fatto il backup.
  if (manifest.systemPluginsTxt) {
    try {
      const bak = `${manifest.systemPluginsTxt}.pre-smm.bak`
      if (existsSync(bak)) {
        copyFileSync(bak, manifest.systemPluginsTxt)
        unlinkSync(bak)
        res.systemPluginsRestored = true
      }
    } catch (e) {
      log('warn', `ripristino plugins.txt di sistema fallito: ${(e as Error).message}`)
    }
  }
  try {
    unlinkSync(toLongPath(manifestPath))
  } catch {
    /* best effort */
  }
  return res
}

/**
 * Purge pubblico (operazione "torna vanilla in un secondo"): manifest-based quando possibile.
 * `allowHeuristic` abilita il fallback nlink per le istanze legacy SENZA manifest — da lasciare
 * false su target che contengono vanilla hardlinkato (StockGame/Data), dove l'euristica
 * cancellerebbe i BSA base.
 */
export function purgeInstance(
  instanceDataDir: string,
  opts: { log?: (level: 'info' | 'warn', msg: string) => void; allowHeuristic?: boolean } = {},
): PurgeResult {
  const log = opts.log ?? (() => {})
  try {
    if (!existsSync(instanceDataDir))
      return {
        success: true,
        manifestFound: false,
        filesRemoved: 0,
        junctionsRemoved: 0,
        dirsPruned: 0,
        skipped: 0,
        systemPluginsRestored: false,
      }
    const res = purgeByManifest(instanceDataDir, log)
    if (!res.manifestFound && opts.allowHeuristic) {
      cleanInstanceLinks(instanceDataDir)
      log('info', `purge euristico (nessun manifest) completato su ${instanceDataDir}`)
      return { ...res, success: true }
    }
    if (!res.manifestFound)
      return {
        ...res,
        success: false,
        error:
          'Nessun manifest di deploy trovato: purge esatto impossibile. Riesegui un deploy (che scrive il manifest) oppure pulisci manualmente.',
      }
    log(
      'info',
      `purge ${instanceDataDir}: ${res.filesRemoved} hardlink rimossi, ${res.junctionsRemoved} junction, ${res.dirsPruned} dir vuote potate, ${res.skipped} file utente preservati`,
    )
    return res
  } catch (e) {
    return {
      success: false,
      manifestFound: false,
      filesRemoved: 0,
      junctionsRemoved: 0,
      dirsPruned: 0,
      skipped: 0,
      systemPluginsRestored: false,
      error: (e as Error).message,
    }
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
    const hasNexus = columnExists(db, 'mods', 'nexus_id')
    const cols = `name, priority, install_path${hasNexus ? ', nexus_id' : ''}${hasMeta ? ', deploy_category, resolution_weight' : ''}`
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

    // 3.5) Load order LOOT-like — PRIMA di qualsiasi scrittura: su ciclo o missing master il
    // deploy si BLOCCA con l'istanza intatta, invece di generare un plugins.txt che crasha il
    // gioco. Fonte di verità: i master REALI dall'header TES4 di ogni plugin; il grafo requires
    // del catalogo resta il fallback per i soli header illeggibili.
    const nexusIdOf = new Map<string, number>()
    for (const r of rows)
      if (typeof r.nexus_id === 'number' && Number.isInteger(r.nexus_id) && r.nexus_id > 0)
        nexusIdOf.set(r.name, r.nexus_id)
    // Masterlist LOOT reale (cache locale, mai un fetch di rete qui) + regole locali: entrambe
    // SOFT, si sommano senza conflitto (lootSort le tratta identicamente).
    const lootCache = loadMasterlistCache(opts.lootMasterlistCachePath)
    const orderedPlugins = orderPluginsLoot(plan.plugins, nexusIdOf, catalogRequires(db), {
      externalMasters: ccPluginOrder(ccPackages),
      rules: [...loadMasterlist(opts.masterlistPath), ...(lootCache?.rules ?? [])],
      groupRankByPattern: lootCache?.groupRankByPattern,
    })
    for (const w of orderedPlugins.warnings) log('warn', `load order: ${w}`)
    if (!orderedPlugins.ok) {
      if (orderedPlugins.kind === 'dependency-cycle') {
        const path = orderedPlugins.cycle.join(' → ')
        log('warn', `deploy BLOCCATO: ciclo di dipendenze nei plugin (${path})`)
        return {
          success: false,
          errorKind: 'dependency-cycle',
          error: `Ciclo di dipendenze tra i plugin: ${path}. Correggi il campo requires nel catalogo o disabilita una delle mod del ciclo, poi riprova.`,
        }
      }
      const detail = orderedPlugins.missing
        .map((m) => `${m.plugin} richiede ${m.masters.join(', ')}`)
        .join('; ')
      log('warn', `deploy BLOCCATO: master mancanti (${detail})`)
      return {
        success: false,
        errorKind: 'missing-master',
        error: `Master mancanti nel deploy: ${detail}. Installa e abilita le mod che forniscono questi master (il gioco crasherebbe al caricamento), poi riprova.`,
      }
    }

    // 4) Purge del deploy precedente. MANIFEST-first (rimozione esatta di ciò che ABBIAMO creato);
    // solo in sua assenza si ricade sull'euristica nlink — sicura su un'istanza dedicata, MAI da
    // usare su un target che contiene vanilla hardlinkato (StockGame: BSA con nlink>1 verso Steam).
    emit({ stage: 'cleaning' })
    try {
      if (existsSync(instanceDataDir)) {
        const purged = purgeByManifest(instanceDataDir, log)
        // Fallback euristico SOLO dove consentito: su un'istanza dedicata è sicuro; sulla
        // Data del GIOCO REALE (allowHeuristicCleanup=false) senza manifest NON si tocca nulla.
        if (!purged.manifestFound && opts.allowHeuristicCleanup !== false)
          cleanInstanceLinks(instanceDataDir)
      }
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
    // Registro degli originali PREESISTENTI sostituiti (target = Data del gioco reale: file
    // vanilla loose/SKSE/CC possono già occupare la destinazione). L'originale va in
    // `<rel>.smm-vanilla.bak` e finisce nel manifest: il purge lo ripristina.
    const backedUp: string[] = []
    const extraLinkedRels: string[] = [] // file linkati fuori dal piano hardlinks (fallback junction)
    const junctionRelsCreated: string[] = [] // SOLO le junction realmente nate (le degradate no)
    const backupIfExists = (destAbs: string, rel: string): void => {
      if (!existsSync(toLongPath(destAbs))) return
      const bak = destAbs + VANILLA_BACKUP_SUFFIX
      // Un .bak già presente è di un deploy precedente non purgato: NON sovrascriverlo
      // (contiene l'originale vero); la destinazione attuale è un residuo nostro.
      if (existsSync(toLongPath(bak))) unlinkSync(toLongPath(destAbs))
      else renameSync(toLongPath(destAbs), toLongPath(bak))
      backedUp.push(rel)
    }
    try {
      for (const j of plan.junctions) {
        const dest = join(instanceDataDir, j.dir)
        mkdirSync(toLongPath(dirname(dest)), { recursive: true })
        try {
          symlinkSync(j.src, dest, 'junction') // Windows directory junction (absolute target)
          junctionsCreated++
          junctionRelsCreated.push(j.dir)
        } catch (e) {
          // Directory già esistente nel target (es. Data/SKSE, Data/Video del gioco reale):
          // la junction non può nascere — si degrada a hardlink file-per-file DENTRO quella
          // directory, con backup degli eventuali originali. Manifest: file singoli, non junction.
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          for (const rel of listFilesRel(j.src)) {
            const fileRel = `${j.dir}/${rel}`
            const fileDest = join(instanceDataDir, fileRel)
            mkdirSync(toLongPath(dirname(fileDest)), { recursive: true })
            backupIfExists(fileDest, fileRel)
            linkSync(toLongPath(join(j.src, rel)), toLongPath(fileDest))
            filesHardlinked++
            extraLinkedRels.push(fileRel)
          }
          log('info', `junction "${j.dir}" degradata a hardlink (directory già presente nel target)`)
        }
        emitLinking(j.dir)
      }
      for (const h of plan.hardlinks) {
        const dest = join(instanceDataDir, h.rel)
        mkdirSync(toLongPath(dirname(dest)), { recursive: true })
        backupIfExists(dest, h.rel)
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
    const ccLinkedRels: string[] = []
    // Target = Data del gioco reale: i contenuti Creation Club sono GIÀ lì (la sorgente CC
    // coincide col target) — nessun linking, ma ccPluginOrder resta per il plugins.txt.
    const ccSameDir =
      !!opts.stockGameDataDir &&
      opts.stockGameDataDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
        instanceDataDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (ccList.length && !ccSameDir) {
      const modDest = new Set(plan.hardlinks.map((h) => h.rel.toLowerCase()))
      for (const f of ccList) {
        if (modDest.has(f.rel.toLowerCase())) continue // a mod patch overrides this CC file
        const dest = join(instanceDataDir, f.rel)
        try {
          mkdirSync(toLongPath(dirname(dest)), { recursive: true })
          linkSync(toLongPath(f.src), toLongPath(dest))
          ccFilesLinked++
          ccLinkedRels.push(f.rel)
        } catch (e) {
          log('warn', `CC "${f.rel}" non collegato (saltato): ${(e as Error).message}`)
        }
      }
    }

    // 6) plugins.txt: copia d'istanza (accanto a Data) + file DI SISTEMA (%LOCALAPPDATA%) quando
    // iniettato — è quello che il gioco legge davvero senza MO2. L'ordine usa i plugin RIORDINATI
    // sul grafo dipendenze (orderedPlugins), coi CC forzati subito dopo i master base.
    emit({ stage: 'plugins' })
    const pluginsPath = join(dirname(instanceDataDir), 'plugins.txt')
    let pluginsWritten = 0
    let systemPluginsTxt: string | undefined
    const txt = buildPluginsTxt(orderedPlugins.plugins, ccPluginOrder(ccPackages))
    try {
      mkdirSync(toLongPath(dirname(pluginsPath)), { recursive: true })
      writeFileSync(pluginsPath, txt, 'utf8')
      pluginsWritten = orderedPlugins.plugins.length
    } catch (e) {
      return { success: false, errorKind: 'link', error: `scrittura plugins.txt fallita: ${(e as Error).message}` }
    }
    if (opts.systemPluginsDir) {
      // Fail-soft: il deploy dei link è valido anche se il file di sistema non è scrivibile; il
      // plugins.txt utente preesistente è salvato UNA volta in .pre-smm.bak (il purge lo ripristina).
      try {
        const sysPath = join(opts.systemPluginsDir, 'plugins.txt')
        mkdirSync(toLongPath(opts.systemPluginsDir), { recursive: true })
        const bak = `${sysPath}.pre-smm.bak`
        if (existsSync(sysPath) && !existsSync(bak)) copyFileSync(sysPath, bak)
        writeFileSync(sysPath, txt, 'utf8')
        systemPluginsTxt = sysPath
      } catch (e) {
        log('warn', `plugins.txt di sistema non scritto (fail-soft): ${(e as Error).message}`)
      }
    }

    // 6.5) Manifest di deploy: l'inventario ESATTO di ciò che abbiamo creato. È ciò che rende il
    // purge sicuro e ripetibile; senza, il purge ricade sull'euristica nlink (pericolosa su target
    // con vanilla hardlinkato). La scrittura è quindi quasi-critica: fallimento = warn esplicito.
    const manifest: DeployManifest = {
      version: 1,
      target: instanceDataDir,
      junctions: junctionRelsCreated, // solo quelle nate davvero (le degradate sono nei files)
      files: [...plan.hardlinks.map((h) => h.rel), ...extraLinkedRels, ...ccLinkedRels],
      backups: backedUp.length ? backedUp : undefined,
      pluginsTxt: pluginsPath,
      systemPluginsTxt,
    }
    try {
      writeFileSync(join(instanceDataDir, DEPLOY_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
    } catch (e) {
      log('warn', `manifest di deploy NON scritto (${(e as Error).message}): il prossimo purge userà l'euristica nlink`)
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

    // 7.5) Dirty-plugin check (ITM/UDR via CRC32 contro il masterlist LOOT reale): PURAMENTE
    // informativo, mai un blocco — la pulizia stessa richiede xEdit (fuori scope). Salta subito
    // se non c'è una cache masterlist (nessuna rete qui, mai: vedi lootMasterlistCachePath).
    let dirtyPlugins: DeployResult['dirtyPlugins']
    if (lootCache?.dirty.length) {
      const candidates = plan.plugins.filter((p) => p.src).map((p) => ({ name: p.name, path: p.src! }))
      const found = await scanDirtyPlugins(candidates, lootCache.dirty)
      if (found.length) {
        dirtyPlugins = found.map((f) => ({ plugin: f.plugin, itm: f.itm, udr: f.udr, nav: f.nav, util: f.util }))
        log(
          'warn',
          `plugin da pulire (ITM/UDR, masterlist LOOT): ${found.map((f) => `${f.plugin} (${f.itm} ITM, ${f.udr} UDR, ${f.nav} NAV — ${f.util})`).join('; ')}`,
        )
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
      systemPluginsPath: systemPluginsTxt,
      iniFilesWritten,
      ccFilesLinked,
      conflictsResolved: plan.resolvedConflicts.length,
      dirtyPlugins,
    }
  } catch (e) {
    return { success: false, errorKind: 'db', error: (e as Error).message }
  }
}
