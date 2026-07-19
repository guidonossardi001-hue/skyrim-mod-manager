import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlugin, buildGrup, buildRecord } from '../plugins/tes4Fixture'
import { openTestDb } from '../db/openTestDb'
import type { SqliteDb } from '../db/sqlite'
import type { TrackedConflict } from './patchTracker'
import {
  runConflictScan,
  getConflictReport,
  filterTrackedConflicts,
  getRecordDetail,
  getXeditTargets,
} from './conflictService'

// Stesso layout del test di conflictIndex, con in più: plugins.txt reale (con voce
// inattiva da escludere) e la patch che overrida ANCHE il conflitto base1 (→ resolved).
const data = (s: string) => Buffer.from(s.padEnd(16, '.'))
const M = { masters: ['Base.esm'] }

describe('runConflictScan + getConflictReport', () => {
  let dir: string
  let dataDir: string
  let pluginsTxtPath: string
  let db: SqliteDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smm-confsvc-'))
    dataDir = join(dir, 'Data')
    mkdirSync(dataDir)
    pluginsTxtPath = join(dir, 'plugins.txt')
    db = openTestDb()

    writeFileSync(
      join(dataDir, 'Base.esm'),
      buildPlugin({ esm: true, masters: [] }, [
        buildGrup('WEAP', [
          buildRecord('WEAP', 0x00_000001, 0, { data: data('base1') }),
          buildRecord('WEAP', 0x00_000002, 0, { data: data('base2') }),
        ]),
      ]),
    )
    writeFileSync(
      join(dataDir, 'ModA.esp'),
      buildPlugin(M, [
        buildGrup('WEAP', [
          buildRecord('WEAP', 0x00_000001, 0, { data: data('A-version') }),
          buildRecord('WEAP', 0x00_000002, 0, { data: data('X-shared') }),
        ]),
      ]),
    )
    writeFileSync(
      join(dataDir, 'ModB.esp'),
      buildPlugin(M, [
        buildGrup('WEAP', [
          buildRecord('WEAP', 0x00_000001, 0, { data: data('B-version') }),
          buildRecord('WEAP', 0x00_000002, 0, { data: data('X-shared') }),
        ]),
      ]),
    )
    writeFileSync(
      join(dataDir, 'Patch.esp'),
      buildPlugin(M, [buildGrup('WEAP', [buildRecord('WEAP', 0x00_000001, 0, { data: data('patched1') })])]),
    )
    // Inattivo: presente su disco ma senza * in plugins.txt → mai scansionato.
    writeFileSync(
      join(dataDir, 'Inactive.esp'),
      buildPlugin(M, [buildGrup('WEAP', [buildRecord('WEAP', 0x00_000001, 0, { data: data('inactive') })])]),
    )
    // Base.esm NON è un master vanilla: come ogni ESM di mod deve stare in plugins.txt.
    writeFileSync(
      pluginsTxtPath,
      '*Base.esm\r\n*ModA.esp\r\n*ModB.esp\r\n*Patch.esp\r\nInactive.esp\r\n',
      'utf8',
    )
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('scansiona solo i plugin ATTIVI del load order reale', async () => {
    const r = await runConflictScan(db, { dataDir, pluginsTxtPath })
    expect(r.ok).toBe(true)
    expect(r.pluginsActive).toBe(4)
    expect(r.summary?.indexed).toBe(4)
    expect(r.summary?.failed).toEqual([])
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM conflict_record WHERE plugin = ?')
      .get('inactive.esp') as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  it('dataDir inesistente → errore onesto, mai throw', async () => {
    const r = await runConflictScan(db, { dataDir: join(dir, 'missing'), pluginsTxtPath })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Data deployata/)
  })

  it('report tracciato: resolved (patch vince) prima in coda a unresolved, identical filtrato', async () => {
    await runConflictScan(db, { dataDir, pluginsTxtPath })
    const report = getConflictReport(db, 'Patch.esp')
    expect(report.ok).toBe(true)
    expect(report.patchName).toBe('Patch.esp')
    expect(report.summary?.total).toBe(2)
    expect(report.summary?.byStatus.resolved).toBe(1) // base1: patch overrida ed è ultima
    expect(report.summary?.byStatus.identical).toBe(1) // base2: override X-shared identici
    // Ordinamento: non-risolti in testa — qui identical (rank 2) prima di resolved (rank 3).
    expect(report.items?.map((i) => i.status)).toEqual(['identical', 'resolved'])
    const resolved = report.items?.find((i) => i.status === 'resolved')
    expect(resolved?.formKey).toBe('base.esm|000001')
    expect(resolved?.winner).toBe('patch.esp')
  })

  it('getRecordDetail: snapshot per ogni partecipante + righe diff con DATA divergente', async () => {
    await runConflictScan(db, { dataDir, pluginsTxtPath })
    const detail = getRecordDetail(db, 'base.esm|000001')
    expect(detail.ok).toBe(true)
    // Partecipanti in ordine di caricamento: Base, ModA, ModB, Patch.
    expect(detail.snapshots?.map((s) => s.displayName)).toEqual([
      'Base.esm',
      'ModA.esp',
      'ModB.esp',
      'Patch.esp',
    ])
    expect(detail.snapshots?.every((s) => s.found)).toBe(true)
    // I payload di fixture sono blob senza subrecord validi → nessuna riga, ma il
    // percorso completo (query + walk + allineamento) è esercitato senza errori.
    expect(detail.rows).toBeDefined()
    expect(getRecordDetail(db, 'base.esm|ffffff').ok).toBe(false)
  })

  it('getXeditTargets: display name in ordine + EDID primo non-null', async () => {
    await runConflictScan(db, { dataDir, pluginsTxtPath })
    const t = getXeditTargets(db, 'base.esm|000001')
    expect(t.ok).toBe(true)
    expect(t.participants).toEqual(['Base.esm', 'ModA.esp', 'ModB.esp', 'Patch.esp'])
    expect(getXeditTargets(db, 'nope|000001').ok).toBe(false)
  })

  it('patch non partecipante → unresolved (il conteggio esclude solo la patch dichiarata)', async () => {
    await runConflictScan(db, { dataDir, pluginsTxtPath })
    const report = getConflictReport(db, 'NonEsiste_Output.esp')
    // base1 ora ha 3 override (ModA, ModB, Patch) → conflitto unresolved.
    const base1 = report.items?.find((i) => i.formKey === 'base.esm|000001')
    expect(base1?.status).toBe('unresolved')
    expect(report.items?.[0]?.status).toBe('unresolved') // unresolved ordinato in testa
  })
})

describe('filterTrackedConflicts (puro)', () => {
  const mk = (
    formKey: string,
    status: TrackedConflict['status'],
    edid: string | null = null,
  ): TrackedConflict => ({
    formKey,
    signature: 'WEAP',
    edid,
    participants: [
      { plugin: 'a.esp', displayName: 'A.esp', orderIdx: 1, dataCrc: 1, isOwn: false },
      { plugin: 'b.esp', displayName: 'B.esp', orderIdx: 2, dataCrc: 2, isOwn: false },
    ],
    identicalOverrides: false,
    status,
    winner: 'b.esp',
  })

  it('filtra per stato (multi-selezione)', () => {
    const items = [mk('k1', 'unresolved'), mk('k2', 'resolved'), mk('k3', 'ignored')]
    const r = filterTrackedConflicts(items, { statuses: ['unresolved', 'ignored'] })
    expect(r.items.map((i) => i.formKey)).toEqual(['k1', 'k3'])
    expect(r.truncated).toBe(false)
  })

  it('search case-insensitive su formKey/EDID/signature/plugin', () => {
    const items = [mk('base.esm|000001', 'unresolved', 'IronSword'), mk('other.esm|000002', 'unresolved')]
    expect(filterTrackedConflicts(items, { search: 'ironsw' }).items).toHaveLength(1)
    expect(filterTrackedConflicts(items, { search: 'OTHER.esm' }).items).toHaveLength(1)
    expect(filterTrackedConflicts(items, { search: 'weap' }).items).toHaveLength(2)
    expect(filterTrackedConflicts(items, { search: 'b.esp' }).items).toHaveLength(2)
    expect(filterTrackedConflicts(items, { search: 'nope' }).items).toHaveLength(0)
  })

  it('limit: cappa e segnala il troncamento', () => {
    const items = [mk('k1', 'unresolved'), mk('k2', 'unresolved'), mk('k3', 'unresolved')]
    const r = filterTrackedConflicts(items, { limit: 2 })
    expect(r.items).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })
})
