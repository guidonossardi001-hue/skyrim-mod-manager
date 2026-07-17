import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { type SqliteDb, applyPragmas } from '../db/sqlite'
import { openTestDb } from '../db/openTestDb'
import { deployInstance, purgeInstance, type DeployProgress } from './deployer'
import { DEPLOY_MANIFEST_FILE } from './plan'

// Integration: real hardlinks + junctions on the SAME tmp volume (junctions need
// no admin on Windows; hardlinks need same volume). Verifies the priority override,
// that sources under modsRoot survive cleanup, and plugins.txt ordering.

let base: string
let modsRoot: string
let instanceData: string
let db: SqliteDb

function testDb(): SqliteDb {
  const d = openTestDb()
  applyPragmas(d)
  d.exec(`
    CREATE TABLE mods (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL, priority INTEGER DEFAULT 0, nexus_id INTEGER,
      is_enabled INTEGER DEFAULT 1, is_installed INTEGER DEFAULT 1, install_path TEXT,
      deploy_category TEXT, resolution_weight INTEGER
    );
  `)
  return d
}

interface ModMeta {
  category?: string
  weight?: number
  nexusId?: number
}

/** Create a deployed mod folder under modsRoot with the given Data-relative files. */
function makeMod(
  name: string,
  priority: number,
  files: Record<string, string>,
  enabled = 1,
  meta: ModMeta = {},
): string {
  const rootDir = join(modsRoot, name)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(rootDir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  db.prepare(
    'INSERT INTO mods (name, priority, is_enabled, is_installed, install_path, deploy_category, resolution_weight, nexus_id) VALUES (?,?,?,1,?,?,?,?)',
  ).run(name, priority, enabled, rootDir, meta.category ?? null, meta.weight ?? null, meta.nexusId ?? null)
  return rootDir
}

/** modlist_catalog col grafo requires (nexus_id → deps) per i test di load order. */
function seedCatalogRequires(edges: Record<number, number[]>): void {
  db.exec('CREATE TABLE IF NOT EXISTS modlist_catalog (nexus_id INTEGER UNIQUE, requires TEXT)')
  const ins = db.prepare('INSERT OR REPLACE INTO modlist_catalog (nexus_id, requires) VALUES (?,?)')
  for (const [id, deps] of Object.entries(edges)) ins.run(Number(id), JSON.stringify(deps))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'smm-deploy-'))
  modsRoot = join(base, 'mods')
  instanceData = join(base, 'profiles', 'Inst', 'Data')
  mkdirSync(modsRoot, { recursive: true })
  db = testDb()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('deployInstance', () => {
  it('deploys with priority override and leaves the modsRoot sources intact', async () => {
    const low = makeMod('Low', 1, { 'shared.txt': 'low', 'onlyLow.txt': 'L' })
    const high = makeMod('High', 2, { 'shared.txt': 'high' })

    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)

    // override: High wins shared.txt
    expect(readFileSync(join(instanceData, 'shared.txt'), 'utf8')).toBe('high')
    expect(readFileSync(join(instanceData, 'onlyLow.txt'), 'utf8')).toBe('L')

    // sources under modsRoot are untouched (read-only guarantee)
    expect(readFileSync(join(low, 'shared.txt'), 'utf8')).toBe('low')
    expect(readFileSync(join(high, 'shared.txt'), 'utf8')).toBe('high')
    expect(existsSync(join(low, 'onlyLow.txt'))).toBe(true)
  })

  it('auto-resolves a texture conflict by resolution_weight read from the DB (4K beats 2K)', async () => {
    // The 4K mod has the LOWER priority (1 < 9) yet still wins: real deploy_category/
    // resolution_weight columns drive the decision, not priority. No conflict is raised.
    makeMod('Tex2K', 9, { 'textures/armor/steel.dds': '2K' }, 1, { category: 'texture', weight: 2000 })
    makeMod('Tex4K', 1, { 'textures/armor/steel.dds': '4K' }, 1, { category: 'texture', weight: 4000 })

    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    // The winning 4K asset is what actually landed in the instance Data.
    expect(readFileSync(join(instanceData, 'textures', 'armor', 'steel.dds'), 'utf8')).toBe('4K')
  })

  it('a patch category beats a higher-priority, higher-weight texture (Rule 1 from real DB data)', async () => {
    makeMod('HDTexture', 9, { 'textures/w.dds': 'TEX' }, 1, { category: 'texture', weight: 8000 })
    makeMod('CompatPatch', 1, { 'textures/w.dds': 'PATCH' }, 1, { category: 'patch' })

    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    expect(readFileSync(join(instanceData, 'textures', 'w.dds'), 'utf8')).toBe('PATCH')
  })

  it('with no deploy metadata falls back to priority (backward compatible)', async () => {
    // No category/weight ⇒ NULL columns ⇒ higher priority wins, exactly as before v8.
    makeMod('Base', 1, { 'textures/x.dds': 'LOW' })
    makeMod('Override', 2, { 'textures/x.dds': 'HIGH' })
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    expect(readFileSync(join(instanceData, 'textures', 'x.dds'), 'utf8')).toBe('HIGH')
  })

  it('creates a block junction for a single-provider directory', async () => {
    makeMod('Textured', 1, { 'textures/set/a.dds': 'AAA', 'textures/set/b.dds': 'BBB', 'root.esp': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    expect(r.junctionsCreated).toBeGreaterThanOrEqual(1)
    // the whole 'textures' tree is a junction (a symlink/junction reparse point)
    expect(lstatSync(join(instanceData, 'textures')).isSymbolicLink()).toBe(true)
    // and the file is readable THROUGH the junction
    expect(readFileSync(join(instanceData, 'textures', 'set', 'a.dds'), 'utf8')).toBe('AAA')
  })

  it('cleanup removes stale links from a prior deploy without touching sources', async () => {
    const low = makeMod('Low', 1, { 'onlyLow.txt': 'L', 'shared.txt': 'low' })
    makeMod('High', 2, { 'shared.txt': 'high' })
    expect((await deployInstance(db, instanceData, { profileId: 1 })).success).toBe(true)
    expect(existsSync(join(instanceData, 'onlyLow.txt'))).toBe(true)

    // Disable Low, redeploy: its link must disappear from the instance, source stays.
    db.prepare("UPDATE mods SET is_enabled=0 WHERE name='Low'").run()
    const r2 = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r2.success).toBe(true)
    expect(existsSync(join(instanceData, 'onlyLow.txt'))).toBe(false) // stale link cleaned
    expect(readFileSync(join(low, 'onlyLow.txt'), 'utf8')).toBe('L') // source preserved
    expect(readFileSync(join(instanceData, 'shared.txt'), 'utf8')).toBe('high')
  })

  it('writes an ordered plugins.txt in the profile dir (masters first, * on mod plugins)', async () => {
    makeMod('PluginA', 1, { 'Alpha.esp': '', 'Light.esl': '' })
    makeMod('PluginB', 2, { 'Big.esm': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    expect(r.pluginsPath).toBe(join(dirname(instanceData), 'plugins.txt'))
    const lines = readFileSync(r.pluginsPath!, 'utf8').trim().split('\n')
    expect(lines).toContain('Skyrim.esm') // base master, unprefixed
    const modLines = lines.filter((l) => l.startsWith('*'))
    expect(modLines).toEqual(['*Big.esm', '*Light.esl', '*Alpha.esp']) // ESM, ESL, ESP
  })

  it('writes per-instance INI (template + mod-required overrides) as the final phase', async () => {
    makeMod('A', 1, { 'a.esp': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1, iniTemplate: 'ultra' })
    expect(r.success).toBe(true)
    expect(r.iniFilesWritten).toBeGreaterThanOrEqual(2)
    const profileDir = dirname(instanceData)
    // A mod-required override (loose-file loading) was injected into Skyrim.ini.
    expect(readFileSync(join(profileDir, 'Skyrim.ini'), 'utf8')).toContain('bInvalidateOlderFiles=1')
    // The 'ultra' template raised the shadow map in SkyrimPrefs.ini.
    expect(readFileSync(join(profileDir, 'SkyrimPrefs.ini'), 'utf8')).toContain('iShadowMapResolution=4096')
  })

  it('respects skipIni (no INI files written)', async () => {
    makeMod('A', 1, { 'a.esp': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1, skipIni: true })
    expect(r.success).toBe(true)
    expect(r.iniFilesWritten).toBe(0)
    expect(existsSync(join(dirname(instanceData), 'Skyrim.ini'))).toBe(false)
  })

  it('emits the ini stage between plugins and done', async () => {
    makeMod('A', 1, { 'a.esp': '' })
    const events: DeployProgress[] = []
    const r = await deployInstance(db, instanceData, { profileId: 1, onProgress: (p) => events.push(p) })
    expect(r.success).toBe(true)
    const stages = events.map((e) => e.stage)
    expect(stages).toContain('ini')
    expect(stages.indexOf('plugins')).toBeLessThan(stages.indexOf('ini'))
    expect(stages.indexOf('ini')).toBeLessThan(stages.indexOf('done'))
  })

  it('treats Creation Club content as System DLC: hardlinks it + load-order after the DLCs', async () => {
    // Simulate CC content sitting in the base-game (StockGame) Data folder.
    const stockData = join(base, 'StockGame', 'Data')
    mkdirSync(stockData, { recursive: true })
    writeFileSync(join(stockData, 'ccBGSSSE001-Fish.esm'), 'FISH-CC')
    writeFileSync(join(stockData, 'ccBGSSSE001-Fish.bsa'), 'FISH-BSA')

    makeMod('SomeMod', 1, { 'SomeMod.esp': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1, stockGameDataDir: stockData })
    expect(r.success).toBe(true)
    expect(r.ccFilesLinked).toBe(2) // esm + bsa

    // The CC plugin is HARDLINKED into the instance (same inode, source untouched).
    const linked = join(instanceData, 'ccBGSSSE001-Fish.esm')
    expect(readFileSync(linked, 'utf8')).toBe('FISH-CC')
    expect(lstatSync(linked).nlink).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(instanceData, 'ccBGSSSE001-Fish.bsa'))).toBe(true)
    // Source in StockGame is immaculate.
    expect(readFileSync(join(stockData, 'ccBGSSSE001-Fish.esm'), 'utf8')).toBe('FISH-CC')

    // plugins.txt: CC ESM forced right after the base masters, BEFORE the mod ESP.
    const lines = readFileSync(r.pluginsPath!, 'utf8').trim().split('\n')
    const iDragonborn = lines.indexOf('Dragonborn.esm') // last official DLC master
    const iCC = lines.indexOf('*ccBGSSSE001-Fish.esm')
    const iMod = lines.indexOf('*SomeMod.esp')
    expect(iCC).toBe(iDragonborn + 1) // immediately after the DLCs
    expect(iMod).toBeGreaterThan(iCC) // mods load after the System DLC block
  })

  it('lets a CC-specific patch mod override the CC file (mod wins the file, CC keeps its slot)', async () => {
    const stockData = join(base, 'StockGame', 'Data')
    mkdirSync(stockData, { recursive: true })
    writeFileSync(join(stockData, 'ccBGSSSE001-Fish.esm'), 'VANILLA-CC')

    // A mod ships the SAME filename (a patch for that CC content).
    makeMod('FishPatch', 5, { 'ccBGSSSE001-Fish.esm': 'PATCHED' })
    const r = await deployInstance(db, instanceData, { profileId: 1, stockGameDataDir: stockData })
    expect(r.success).toBe(true)
    expect(r.ccFilesLinked).toBe(0) // the mod already provided that name → CC skipped

    // The PATCH content is what deployed, not the base CC file.
    expect(readFileSync(join(instanceData, 'ccBGSSSE001-Fish.esm'), 'utf8')).toBe('PATCHED')
    // The plugin still appears once, in the CC slot (right after the DLCs).
    const lines = readFileSync(r.pluginsPath!, 'utf8').trim().split('\n')
    expect(lines.filter((l) => /ccBGSSSE001-Fish\.esm/i.test(l))).toHaveLength(1)
    expect(lines.indexOf('*ccBGSSSE001-Fish.esm')).toBe(lines.indexOf('Dragonborn.esm') + 1)
  })

  it('gracefully deploys a legacy game with no Creation Club content (no throw, 0 CC)', async () => {
    const stockData = join(base, 'LegacyStock', 'Data')
    mkdirSync(stockData, { recursive: true })
    writeFileSync(join(stockData, 'Skyrim.esm'), 'BASE') // vanilla, not CC
    makeMod('M', 1, { 'M.esp': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1, stockGameDataDir: stockData })
    expect(r.success).toBe(true)
    expect(r.ccFilesLinked).toBe(0)
    expect(existsSync(join(instanceData, 'Skyrim.esm'))).toBe(false) // vanilla base is never CC-linked
  })

  it('refuses a cross-volume deploy before touching anything', async () => {
    makeMod('X', 1, { 'a.txt': 'x' })
    // A different drive letter than the tmp volume forces sameVolume() to fail.
    const otherVol = 'Z:\\nolvus\\Inst\\Data'
    const r = await deployInstance(db, otherVol, { profileId: 1 })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('cross-volume')
    expect(existsSync(otherVol)).toBe(false) // nothing created
  })

  it('returns no-mods when nothing is enabled', async () => {
    makeMod('Off', 1, { 'a.txt': 'x' }, /* enabled */ 0)
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('no-mods')
  })

  it('reports source-missing when a deployed folder vanished', async () => {
    const dir = makeMod('Gone', 1, { 'a.txt': 'x' })
    rmSync(dir, { recursive: true, force: true })
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('source-missing')
  })

  it('emits onProgress through every stage in order, ending at done/100%', async () => {
    makeMod('A', 1, { 'a.txt': '1', 'b.txt': '2' })
    const events: DeployProgress[] = []
    const r = await deployInstance(db, instanceData, { profileId: 1, onProgress: (p) => events.push(p) })
    expect(r.success).toBe(true)
    const stages = events.map((e) => e.stage)
    // each phase fired, in pipeline order
    expect(stages).toContain('scanning')
    expect(stages).toContain('cleaning')
    expect(stages).toContain('linking')
    expect(stages).toContain('plugins')
    expect(stages).toContain('done')
    expect(stages.indexOf('scanning')).toBeLessThan(stages.indexOf('cleaning'))
    expect(stages.indexOf('cleaning')).toBeLessThan(stages.indexOf('linking'))
    expect(stages.indexOf('linking')).toBeLessThan(stages.indexOf('plugins'))
    expect(stages.indexOf('plugins')).toBeLessThan(stages.indexOf('done'))
    const last = events[events.length - 1]
    expect(last.stage).toBe('done')
    expect(last.percent).toBe(100)
  })

  it('throttles linking progress and reports monotonically increasing percentages', async () => {
    // 250 root files ⇒ 250 hardlinks (root files never junction) ⇒ multiple emits.
    const files: Record<string, string> = {}
    for (let i = 0; i < 250; i++) files[`f${String(i).padStart(3, '0')}.txt`] = String(i)
    makeMod('Big', 1, files)

    const linking: DeployProgress[] = []
    const r = await deployInstance(db, instanceData, {
      profileId: 1,
      onProgress: (p) => p.stage === 'linking' && linking.push(p),
    })
    expect(r.success).toBe(true)
    // throttled at every 100 + first + last ⇒ far fewer emits than 250 items
    expect(linking.length).toBeGreaterThanOrEqual(3)
    expect(linking.length).toBeLessThan(250)
    // percentages never go backwards, and processedItems climbs to the total
    for (let i = 1; i < linking.length; i++) {
      expect(linking[i].percent!).toBeGreaterThanOrEqual(linking[i - 1].percent!)
      expect(linking[i].processedItems!).toBeGreaterThan(linking[i - 1].processedItems!)
    }
    const lastLink = linking[linking.length - 1]
    expect(lastLink.processedItems).toBe(lastLink.totalItems)
    expect(lastLink.percent).toBe(100)
    expect(lastLink.currentFile).toBeTruthy()
  })

  it('LOAD ORDER: il grafo requires vince sulla priorità utente (dipendenza prima del dipendente)', async () => {
    // L'utente ha dato al Dependent priorità PIÙ BASSA della sua master library: senza il
    // riordino topologico il plugins.txt caricherebbe il dipendente prima della sua master.
    makeMod('DependentQuest', 1, { 'Quest.esp': '' }, 1, { nexusId: 100 })
    makeMod('MasterLib', 9, { 'Lib.esp': '' }, 1, { nexusId: 200 })
    seedCatalogRequires({ 100: [200] }) // Quest richiede Lib
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    const lines = readFileSync(r.pluginsPath!, 'utf8').trim().split('\n')
    expect(lines.indexOf('*Lib.esp')).toBeLessThan(lines.indexOf('*Quest.esp'))
  })

  // ── Master mancanti: DISATTIVAZIONE mirata, non più blocco totale ─────────────
  // Caso reale 2026-07-17: UN patch senza master (FOMOD del master mai applicato)
  // bloccava l'intero deploy → plugins.txt mai scritta → gioco avviato VANILLA con
  // 1939 mod abilitate. Ora il plugin orfano viene escluso da plugins.txt (file
  // deployato, inerte) e il resto va a segno; il blocco resta solo a zero superstiti.

  it('MASTER MANCANTI: il patch orfano è disattivato, il deploy prosegue e lo riporta', async () => {
    const { buildTes4 } = await import('../plugins/tes4Fixture')
    const good = makeMod('GoodMod', 1, { 'meshes/g.nif': 'x' })
    writeFileSync(join(good, 'Good.esp'), buildTes4({ masters: ['Skyrim.esm'] }))
    const orphan = makeMod('OrphanPatch', 2, { 'meshes/p.nif': 'x' })
    writeFileSync(join(orphan, 'Patch.esp'), buildTes4({ masters: ['AssenteLib.esp'] }))

    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    expect(r.skippedPlugins).toEqual([{ plugin: 'Patch.esp', masters: ['AssenteLib.esp'] }])
    const lines = readFileSync(r.pluginsPath!, 'utf8').trim().split('\n')
    expect(lines).toContain('*Good.esp')
    expect(lines).not.toContain('*Patch.esp')
    // Il FILE del plugin orfano resta deployato (inerte senza riga in plugins.txt).
    expect(existsSync(join(instanceData, 'Patch.esp'))).toBe(true)
  })

  it('MASTER MANCANTI a cascata: chi dipendeva dal disattivato cade con lui', async () => {
    const { buildTes4 } = await import('../plugins/tes4Fixture')
    const good = makeMod('GoodMod', 1, { 'meshes/g.nif': 'x' })
    writeFileSync(join(good, 'Good.esp'), buildTes4({ masters: ['Skyrim.esm'] }))
    const orphanA = makeMod('OrphanA', 2, { 'meshes/a.nif': 'x' })
    writeFileSync(join(orphanA, 'A.esp'), buildTes4({ masters: ['Assente.esp'] }))
    const depA = makeMod('DependsOnA', 3, { 'meshes/b.nif': 'x' })
    writeFileSync(join(depA, 'B.esp'), buildTes4({ masters: ['A.esp'] }))

    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    expect((r.skippedPlugins ?? []).map((s) => s.plugin).sort()).toEqual(['A.esp', 'B.esp'])
    const lines = readFileSync(r.pluginsPath!, 'utf8').trim().split('\n')
    expect(lines).toContain('*Good.esp')
    expect(lines).not.toContain('*A.esp')
    expect(lines).not.toContain('*B.esp')
  })

  it('MASTER MANCANTI ovunque: zero plugin attivabili → il deploy resta BLOCCATO', async () => {
    const { buildTes4 } = await import('../plugins/tes4Fixture')
    const broken = makeMod('Broken', 1, { 'meshes/s.nif': 'x' })
    writeFileSync(join(broken, 'Solo.esp'), buildTes4({ masters: ['MaiVista.esp'] }))
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('missing-master')
    expect(r.error).toMatch(/Nessun plugin attivabile/)
  })

  it('FAIL-SAFE: un ciclo di dipendenze BLOCCA il deploy senza toccare l’istanza', async () => {
    makeMod('CycA', 1, { 'A.esp': '' }, 1, { nexusId: 1 })
    makeMod('CycB', 2, { 'B.esp': '' }, 1, { nexusId: 2 })
    seedCatalogRequires({ 1: [2], 2: [1] }) // A ↔ B
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(false)
    expect(r.errorKind).toBe('dependency-cycle')
    expect(r.error).toMatch(/Ciclo di dipendenze/)
    expect(existsSync(instanceData)).toBe(false) // nulla creato: gate PRIMA del cleanup/link
  })

  it('MANIFEST: il deploy registra link e junction; il purge rimuove ESATTAMENTE quelli', async () => {
    const src = makeMod('M', 1, { 'a.esp': 'PLUGIN', 'textures/set/t.dds': 'TEX' })
    const r = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r.success).toBe(true)
    const manifestPath = join(instanceData, DEPLOY_MANIFEST_FILE)
    expect(existsSync(manifestPath)).toBe(true)
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(m.version).toBe(1)
    expect(m.files).toContain('a.esp')
    expect(m.junctions).toContain('textures')

    // File "proprio" dell'utente nell'istanza (nlink=1): il purge NON deve toccarlo.
    writeFileSync(join(instanceData, 'user-notes.txt'), 'mio')
    const p = purgeInstance(instanceData, {})
    expect(p.success).toBe(true)
    expect(p.manifestFound).toBe(true)
    expect(p.filesRemoved).toBeGreaterThanOrEqual(1)
    expect(p.junctionsRemoved).toBe(1)
    expect(existsSync(join(instanceData, 'a.esp'))).toBe(false)
    expect(existsSync(join(instanceData, 'textures'))).toBe(false)
    expect(readFileSync(join(instanceData, 'user-notes.txt'), 'utf8')).toBe('mio') // preservato
    expect(existsSync(manifestPath)).toBe(false) // manifest consumato
    // Sorgenti mai toccate.
    expect(readFileSync(join(src, 'a.esp'), 'utf8')).toBe('PLUGIN')
    expect(readFileSync(join(src, 'textures/set/t.dds'), 'utf8')).toBe('TEX')
  })

  it('PURGE fail-safe: senza manifest e senza fallback euristico rifiuta con errore chiaro', async () => {
    mkdirSync(instanceData, { recursive: true })
    writeFileSync(join(instanceData, 'qualcosa.txt'), 'x')
    const p = purgeInstance(instanceData, { allowHeuristic: false })
    expect(p.success).toBe(false)
    expect(p.manifestFound).toBe(false)
    expect(p.error).toMatch(/manifest/i)
    expect(existsSync(join(instanceData, 'qualcosa.txt'))).toBe(true) // nulla rimosso
  })

  it('PLUGINS DI SISTEMA: scrive %LOCALAPPDATA%-style plugins.txt con backup e il purge lo ripristina', async () => {
    const sysDir = join(base, 'LocalAppData', 'Skyrim Special Edition')
    mkdirSync(sysDir, { recursive: true })
    writeFileSync(join(sysDir, 'plugins.txt'), '*VecchioOrdine.esp\n') // file utente preesistente
    makeMod('M', 1, { 'M.esp': '' })
    const r = await deployInstance(db, instanceData, { profileId: 1, systemPluginsDir: sysDir })
    expect(r.success).toBe(true)
    expect(r.systemPluginsPath).toBe(join(sysDir, 'plugins.txt'))
    expect(readFileSync(join(sysDir, 'plugins.txt'), 'utf8')).toContain('*M.esp')
    expect(readFileSync(join(sysDir, 'plugins.txt.pre-smm.bak'), 'utf8')).toBe('*VecchioOrdine.esp\n')

    const p = purgeInstance(instanceData, {})
    expect(p.success).toBe(true)
    expect(p.systemPluginsRestored).toBe(true)
    expect(readFileSync(join(sysDir, 'plugins.txt'), 'utf8')).toBe('*VecchioOrdine.esp\n') // ripristinato
    expect(existsSync(join(sysDir, 'plugins.txt.pre-smm.bak'))).toBe(false)
  })

  it('REDEPLOY con manifest: il secondo deploy purga via manifest e rimpiazza i link (mai le sorgenti)', async () => {
    makeMod('Old', 1, { 'old.esp': 'OLD' })
    expect((await deployInstance(db, instanceData, { profileId: 1 })).success).toBe(true)
    db.prepare("UPDATE mods SET is_enabled=0 WHERE name='Old'").run()
    makeMod('New', 2, { 'new.esp': 'NEW' })
    const r2 = await deployInstance(db, instanceData, { profileId: 1 })
    expect(r2.success).toBe(true)
    expect(existsSync(join(instanceData, 'old.esp'))).toBe(false) // rimosso via manifest
    expect(readFileSync(join(instanceData, 'new.esp'), 'utf8')).toBe('NEW')
    expect(readFileSync(join(modsRoot, 'Old', 'old.esp'), 'utf8')).toBe('OLD') // sorgente intatta
  })
})
