import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVortexFolderName,
  parseCollection,
  dedupeMods,
  scanVortexMods,
  buildCatalog,
  defaultVortexModsRoot,
  isBaseResource,
  type VortexMod,
} from './scan'

describe('Vortex folder-name → modId (best-effort)', () => {
  it('extracts the modId from the Vortex naming convention', () => {
    expect(
      parseVortexFolderName('(Part 1) Engine Fixes for 1.6.1170 and newer-17230-7-0-14-1756302354')?.modId,
    ).toBe(17230)
    expect(parseVortexFolderName("0400's face preset-148574-4-1745582110")?.modId).toBe(148574)
    expect(parseVortexFolderName('-Buxom Wench Yuriana--598-1-5-4ASE-1658678384')?.modId).toBe(598)
    expect(parseVortexFolderName('1 Pubic hairstyles all in one CBBE-19990-1-0')?.modId).toBe(19990)
  })
  it('returns null for a folder without a parseable modId', () => {
    expect(parseVortexFolderName('SomeLooseFolder')).toBeNull()
  })
})

// Mirrors the real collection.json shape (mods[].source = {type:'nexus', modId, fileId, …}).
function collection(
  name: string,
  mods: Partial<{
    modId: number
    fileId: number
    optional: boolean
    name: string
    md5: string
    fileSize: number
  }>[],
) {
  return {
    info: { name },
    mods: mods.map((m) => ({
      name: m.name ?? `Mod ${m.modId}`,
      optional: m.optional ?? false,
      source: {
        type: 'nexus',
        modId: m.modId,
        fileId: m.fileId,
        md5: m.md5,
        fileSize: m.fileSize,
        logicalFilename: m.name,
      },
    })),
  }
}

describe('collection.json parsing', () => {
  it('extracts Nexus modId/fileId and skips non-nexus sources', () => {
    const json = {
      info: { name: 'MY-MODS' },
      mods: [
        {
          name: 'CBBE Overlays',
          optional: false,
          source: { type: 'nexus', modId: 22487, fileId: 77989, md5: 'abc', fileSize: 51132202 },
        },
        { name: 'Bundled', optional: false, source: { type: 'bundle' } }, // not nexus → skipped
        { name: 'No source' }, // skipped
      ],
    }
    const mods = parseCollection(json, 'MY-MODS')
    expect(mods).toHaveLength(1)
    expect(mods[0]).toMatchObject({
      modId: 22487,
      fileId: 77989,
      optional: false,
      source: 'collection',
      collection: 'MY-MODS',
    })
  })
})

describe('de-duplication', () => {
  it('keeps the strongest record per modId (collection > folder, required > optional, newest fileId)', () => {
    const mods: VortexMod[] = [
      { modId: 17230, fileId: 100, name: 'old', optional: false, source: 'collection' },
      { modId: 17230, fileId: 489502, name: 'new', optional: false, source: 'collection' }, // newest fileId wins
      { modId: 17230, fileId: null, name: 'folder', optional: false, source: 'folder' },
      { modId: 598, fileId: 1, name: 'opt', optional: true, source: 'collection' },
      { modId: 598, fileId: 2, name: 'req', optional: false, source: 'collection' }, // required beats optional
    ]
    const { mods: out, removed } = dedupeMods(mods)
    expect(removed).toBe(3)
    expect(out.map((m) => m.modId)).toEqual([598, 17230])
    expect(out.find((m) => m.modId === 17230)?.fileId).toBe(489502)
    expect(out.find((m) => m.modId === 598)?.optional).toBe(false)
  })
})

describe('filesystem scan + catalog build', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vortex-'))
    // two collections that overlap on modId 17230 (Engine Fixes), plus a loose folder mod
    const c1 = join(root, 'MY-MODS-548532-1-1758454980')
    mkdirSync(c1)
    writeFileSync(
      join(c1, 'collection.json'),
      JSON.stringify(
        collection('MY-MODS', [
          { modId: 22487, fileId: 77989, name: 'CBBE Overlays', fileSize: 1000 },
          { modId: 17230, fileId: 489502, name: 'Engine Fixes', fileSize: 500 },
        ]),
      ),
    )
    const c2 = join(root, 'Mon-Skyril-543128-1-1757591682')
    mkdirSync(c2)
    writeFileSync(
      join(c2, 'collection.json'),
      JSON.stringify(
        collection('Mon-Skyril', [
          { modId: 17230, fileId: 100, name: 'Engine Fixes (older)' }, // duplicate, older fileId
          { modId: 32444, fileId: 5000, name: 'Address Library' }, // base resource
        ]),
      ),
    )
    mkdirSync(join(root, 'Some Loose Mod-99999-1-0-1700000000')) // folder-only mod
    mkdirSync(join(root, 'NoSkseHere')) // unparseable → ignored
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('merges both collections, de-dups, and adds folder-only mods', () => {
    const scan = scanVortexMods(root)
    expect(scan.collections.sort()).toEqual(['MY-MODS', 'Mon-Skyril'])
    expect(scan.duplicatesRemoved).toBe(1) // the older 17230
    const ids = scan.mods.map((m) => m.modId).sort((a, b) => a - b)
    expect(ids).toEqual([17230, 22487, 32444, 99999])
    expect(scan.mods.find((m) => m.modId === 17230)?.fileId).toBe(489502) // newest kept
    expect(scan.mods.find((m) => m.modId === 99999)?.source).toBe('folder')
    expect(scan.totalBytes).toBe(1500) // 1000 + 500 (deduped mods with fileSize)
  })

  it('builds a catalog flagging base resources', () => {
    const cat = buildCatalog(scanVortexMods(root))
    expect(cat.source).toBe('vortex')
    expect(cat.total).toBe(4)
    expect(cat.mods.find((m) => m.nexus_id === 32444)?.required_resource).toBe(true)
    expect(cat.mods.find((m) => m.nexus_id === 22487)?.required_resource).toBe(false)
  })

  it('returns empty for a missing root', () => {
    expect(scanVortexMods(join(root, 'nope')).mods).toEqual([])
  })
})

describe('helpers', () => {
  it('resolves the default Vortex mods root from APPDATA', () => {
    expect(defaultVortexModsRoot('C:/Users/X/AppData/Roaming')).toBe(
      join('C:/Users/X/AppData/Roaming', 'Vortex', 'skyrimse', 'mods'),
    )
    expect(defaultVortexModsRoot('')).toBeNull()
  })
  it('flags known base frameworks', () => {
    expect(isBaseResource(17230)).toBe(true)
    expect(isBaseResource(999999)).toBe(false)
  })
})
