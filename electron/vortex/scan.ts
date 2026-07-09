import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// Vortex importer. Reads an existing Vortex Skyrim SE staging folder and reconstructs
// the Nexus mod list from the AUTHORITATIVE source — the `collection.json` files that
// Vortex writes for installed collections (each mod carries source.modId/fileId/md5/
// fileSize/optional/phase). The folder NAME (`<name>-<modId>-<version>-<timestamp>`) is
// a best-effort secondary signal for mods installed outside a collection.
//
// NOTE: this installation has no per-mod `__vortex_meta.json` (Vortex stores that in the
// `state.v2` LevelDB); collection.json + folder names are the real, file-readable sources.
// Everything here is READ-ONLY and pure where possible, so it is fully unit-testable.

export interface VortexMod {
  modId: number
  fileId: number | null
  name: string
  fileSize?: number
  md5?: string
  optional: boolean
  phase?: number
  source: 'collection' | 'folder'
  collection?: string
}

export interface VortexScan {
  collections: string[]
  mods: VortexMod[]
  folderCount: number
  fromCollections: number
  fromFolders: number
  duplicatesRemoved: number
  totalBytes: number // sum of archive sizes across the de-duplicated mods
}

// ── Folder name → modId (best-effort) ────────────────────────────────────────
// "(Part 1) Engine Fixes...-17230-7-0-14-1756302354" → 17230. The modId is the first
// 2–7 digit group that is followed by a `-<digit>` (the version), which skips dotted
// numbers inside the human name. Nexus mod ids are ≤ 7 digits.
export function parseVortexFolderName(folder: string): { modId: number; name: string } | null {
  const m = folder.match(/-(\d{2,7})-\d/)
  if (!m) return null
  const modId = Number(m[1])
  const name = folder.slice(0, m.index).replace(/-+$/, '').trim() || folder
  return { modId, name }
}

// ── collection.json → mods ───────────────────────────────────────────────────
interface RawCollectionMod {
  name?: string
  optional?: boolean
  phase?: number
  source?: {
    type?: string
    modId?: number
    fileId?: number
    md5?: string
    fileSize?: number
    logicalFilename?: string
  }
}

export function parseCollection(json: unknown, collectionName: string): VortexMod[] {
  const mods = (json as { mods?: RawCollectionMod[] } | null)?.mods
  if (!Array.isArray(mods)) return []
  const out: VortexMod[] = []
  for (const m of mods) {
    const s = m.source
    if (!s || s.type !== 'nexus' || typeof s.modId !== 'number') continue // only Nexus-sourced mods
    out.push({
      modId: s.modId,
      fileId: typeof s.fileId === 'number' ? s.fileId : null,
      name: s.logicalFilename ?? m.name ?? `Mod ${s.modId}`,
      fileSize: s.fileSize,
      md5: s.md5,
      optional: !!m.optional,
      phase: m.phase,
      source: 'collection',
      collection: collectionName,
    })
  }
  return out
}

// ── De-duplication ───────────────────────────────────────────────────────────
// Key by (modId, fileId). When the same modId appears more than once, keep the
// strongest entry: a collection record (has fileId) beats a folder record; a
// REQUIRED mod beats an optional one; otherwise the highest fileId (newest) wins.
export function dedupeMods(mods: VortexMod[]): { mods: VortexMod[]; removed: number } {
  const best = new Map<number, VortexMod>()
  let removed = 0
  const score = (m: VortexMod) =>
    (m.source === 'collection' ? 4 : 0) + (m.optional ? 0 : 2) + (m.fileId != null ? 1 : 0)
  for (const m of mods) {
    const cur = best.get(m.modId)
    if (!cur) {
      best.set(m.modId, m)
      continue
    }
    removed++
    const better = score(m) > score(cur) || (score(m) === score(cur) && (m.fileId ?? 0) > (cur.fileId ?? 0))
    if (better) best.set(m.modId, m)
  }
  return { mods: [...best.values()].sort((a, b) => a.modId - b.modId), removed }
}

// Base frameworks every Skyrim modlist needs to function — flagged so the catalog
// never silently drops them during de-dup (they are already in well-formed collections).
export const BASE_RESOURCE_MOD_IDS = new Set([
  17230, // SKSE / SSE Engine Fixes line
  32444, // Address Library for SKSE Plugins
  106097, // Unofficial Skyrim Special Edition Patch (USSEP)
])

export function isBaseResource(modId: number): boolean {
  return BASE_RESOURCE_MOD_IDS.has(modId)
}

// ── Filesystem scan (electron side) ──────────────────────────────────────────
export function defaultVortexModsRoot(appData?: string): string | null {
  const base = appData ?? process.env.APPDATA
  return base ? join(base, 'Vortex', 'skyrimse', 'mods') : null
}

export function scanVortexMods(modsRoot: string): VortexScan {
  if (!existsSync(modsRoot))
    return {
      collections: [],
      mods: [],
      folderCount: 0,
      fromCollections: 0,
      fromFolders: 0,
      duplicatesRemoved: 0,
      totalBytes: 0,
    }

  const entries = readdirSync(modsRoot).filter((name) => {
    try {
      return statSync(join(modsRoot, name)).isDirectory()
    } catch {
      return false
    }
  })

  const collections: string[] = []
  const collected: VortexMod[] = []
  const collectionDirs = new Set<string>()
  for (const dir of entries) {
    const cj = join(modsRoot, dir, 'collection.json')
    if (!existsSync(cj)) continue
    collectionDirs.add(dir) // this folder is a collection CONTAINER, not an individual mod
    try {
      const json = JSON.parse(readFileSync(cj, 'utf8'))
      const name = (json?.info?.name as string) ?? dir
      collections.push(name)
      collected.push(...parseCollection(json, name))
    } catch {
      /* skip malformed collection */
    }
  }

  // Folder-derived modIds NOT already covered by a collection (best-effort, fileId unknown).
  // Skip collection containers — their folder name encodes the COLLECTION's own Nexus id.
  const known = new Set(collected.map((m) => m.modId))
  const folderMods: VortexMod[] = []
  for (const dir of entries) {
    if (collectionDirs.has(dir)) continue
    const parsed = parseVortexFolderName(dir)
    if (parsed && !known.has(parsed.modId)) {
      folderMods.push({
        modId: parsed.modId,
        fileId: null,
        name: parsed.name,
        optional: false,
        source: 'folder',
      })
    }
  }

  const fromCollections = collected.length
  const fromFolders = folderMods.length
  const { mods, removed } = dedupeMods([...collected, ...folderMods])
  const totalBytes = mods.reduce((acc, m) => acc + (m.fileSize ?? 0), 0)
  return {
    collections,
    mods,
    folderCount: entries.length,
    fromCollections,
    fromFolders,
    duplicatesRemoved: removed,
    totalBytes,
  }
}

// ── Catalog build ────────────────────────────────────────────────────────────
export interface VortexCatalog {
  source: 'vortex'
  collections: string[]
  total: number
  mods: {
    nexus_id: number
    file_id: number | null
    name: string
    file_size?: number
    md5?: string
    optional: boolean
    required_resource: boolean
  }[]
}

export function buildCatalog(scan: VortexScan): VortexCatalog {
  return {
    source: 'vortex',
    collections: scan.collections,
    total: scan.mods.length,
    mods: scan.mods.map((m) => ({
      nexus_id: m.modId,
      file_id: m.fileId,
      name: m.name,
      file_size: m.fileSize,
      md5: m.md5,
      optional: m.optional,
      required_resource: isBaseResource(m.modId),
    })),
  }
}
