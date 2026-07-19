import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlugin, buildGrup, buildRecord } from '../plugins/tes4Fixture'
import { openTestDb } from '../db/openTestDb'
import type { SqliteDb } from '../db/sqlite'
import {
  indexLoadOrder,
  indexLoadOrderAsync,
  listConflicts,
  type ConflictPluginInput,
  type IndexProgress,
} from './conflictIndex'

// Layout di prova:
//   Base.esm (0 master)      → definisce i record propri 0x000001..0x000003
//   ModA.esp [Base.esm]      → override di 1 (dati A), 2 (dati X), 3 (dati A3)
//   ModB.esp [Base.esm]      → override di 1 (dati B ≠ A) e 2 (dati X identici)
//   Patch.esp [Base.esm]     → override di 3 (la "patch di risoluzione")
// Attesi: 1 = conflitto reale; 2 = conflitto identical; 3 = singolo override (nessun
// conflitto) che DIVENTA conflitto solo se la patch non è esclusa dal conteggio.

const data = (s: string) => Buffer.from(s.padEnd(16, '.'))
const base = () =>
  buildPlugin({ esm: true, masters: [] }, [
    buildGrup('WEAP', [
      buildRecord('WEAP', 0x00_000001, 0, { data: data('base1') }),
      buildRecord('WEAP', 0x00_000002, 0, { data: data('base2') }),
      buildRecord('WEAP', 0x00_000003, 0, { data: data('base3') }),
    ]),
  ])
const M = { masters: ['Base.esm'] }
const modA = () =>
  buildPlugin(M, [
    buildGrup('WEAP', [
      buildRecord('WEAP', 0x00_000001, 0, { data: data('A-version') }),
      buildRecord('WEAP', 0x00_000002, 0, { data: data('X-shared') }),
      buildRecord('WEAP', 0x00_000003, 0, { data: data('A3') }),
    ]),
  ])
const modB = (payload1 = 'B-version') =>
  buildPlugin(M, [
    buildGrup('WEAP', [
      buildRecord('WEAP', 0x00_000001, 0, { data: data(payload1) }),
      buildRecord('WEAP', 0x00_000002, 0, { data: data('X-shared') }),
    ]),
  ])
const patch = () =>
  buildPlugin(M, [buildGrup('WEAP', [buildRecord('WEAP', 0x00_000003, 0, { data: data('patched3') })])])

describe('indexLoadOrder + listConflicts', () => {
  let dir: string
  let db: SqliteDb
  let order: ConflictPluginInput[]

  const write = (name: string, buf: Buffer): ConflictPluginInput => {
    const path = join(dir, name)
    writeFileSync(path, buf)
    return { name, path }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smm-conflicts-'))
    db = openTestDb()
    order = [
      write('Base.esm', base()),
      write('ModA.esp', modA()),
      write('ModB.esp', modB()),
      write('Patch.esp', patch()),
    ]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('indicizza il load order e rileva i conflitti (reale vs identical vs singolo override)', () => {
    const summary = indexLoadOrder(db, order)
    expect(summary.indexed).toBe(4)
    expect(summary.failed).toEqual([])
    expect(summary.totalRecords).toBe(3 + 3 + 2 + 1)

    const conflicts = listConflicts(db, { excludeFromCount: 'Patch.esp' })
    expect(conflicts.map((c) => c.formKey).sort()).toEqual(['base.esm|000001', 'base.esm|000002'])

    const real = conflicts.find((c) => c.formKey === 'base.esm|000001')!
    expect(real.identicalOverrides).toBe(false)
    expect(real.signature).toBe('WEAP')
    // Partecipanti in ordine di caricamento: origine + i due override.
    expect(real.participants.map((p) => p.plugin)).toEqual(['base.esm', 'moda.esp', 'modb.esp'])
    expect(real.participants[0].isOwn).toBe(true)

    const identical = conflicts.find((c) => c.formKey === 'base.esm|000002')!
    expect(identical.identicalOverrides).toBe(true)
  })

  it('la patch esclusa dal conteggio non trasforma un singolo override in conflitto', () => {
    indexLoadOrder(db, order)
    // Senza esclusione: base3 ha 2 override (ModA + Patch) → contato come conflitto.
    const raw = listConflicts(db)
    expect(raw.some((c) => c.formKey === 'base.esm|000003')).toBe(true)
    // Con esclusione: resta solo l'override di ModA → non è un conflitto tra mod.
    const filtered = listConflicts(db, { excludeFromCount: 'Patch.esp' })
    expect(filtered.some((c) => c.formKey === 'base.esm|000003')).toBe(false)
  })

  it('warm run: (size, mtime) invariati → nessuna rilettura binaria', () => {
    indexLoadOrder(db, order)
    const second = indexLoadOrder(db, order)
    expect(second.cached).toBe(4)
    expect(second.indexed).toBe(0)
    expect(listConflicts(db, { excludeFromCount: 'Patch.esp' })).toHaveLength(2)
  })

  it('file modificato (size diversa) → rescan del solo plugin cambiato', () => {
    indexLoadOrder(db, order)
    writeFileSync(order[2].path, modB('B-version-changed-and-longer'))
    const second = indexLoadOrder(db, order)
    expect(second.indexed).toBe(1)
    expect(second.cached).toBe(3)
  })

  it('plugin rimosso dal load order → righe potate, conflitto sparisce', () => {
    indexLoadOrder(db, order)
    const without = order.filter((p) => p.name !== 'ModB.esp')
    indexLoadOrder(db, without)
    const conflicts = listConflicts(db, { excludeFromCount: 'Patch.esp' })
    expect(conflicts).toHaveLength(0)
  })

  it('file sparito dal disco → failed, mai righe fantasma', () => {
    indexLoadOrder(db, order)
    rmSync(order[1].path)
    const second = indexLoadOrder(db, order)
    expect(second.failed).toEqual(['ModA.esp'])
    const conflicts = listConflicts(db, { excludeFromCount: 'Patch.esp' })
    expect(conflicts).toHaveLength(0) // senza ModA resta un solo override per chiave
  })

  it('driver async: stessa semantica del sincrono + progress per ogni plugin', async () => {
    const events: IndexProgress[] = []
    const summary = await indexLoadOrderAsync(db, order, (p) => events.push(p))
    expect(summary.indexed).toBe(4)
    expect(summary.failed).toEqual([])
    expect(events).toHaveLength(4)
    expect(events[3]).toMatchObject({ done: 4, total: 4, cached: false })
    expect(listConflicts(db, { excludeFromCount: 'Patch.esp' })).toHaveLength(2)
    // Warm run async sopra cache scritta dal sync driver e viceversa: stessa cache.
    const warm = indexLoadOrder(db, order)
    expect(warm.cached).toBe(4)
  })

  it('plugin corrotto → parse fallito, escluso dall analisi senza record parziali', () => {
    const corrupt = write('Corrupt.esp', Buffer.concat([modA(), Buffer.from('garbage-tail')]))
    const summary = indexLoadOrder(db, [...order, corrupt])
    expect(summary.failed).toEqual(['Corrupt.esp'])
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM conflict_record WHERE plugin = ?')
      .get('corrupt.esp') as {
      n: number
    }
    expect(rows.n).toBe(0)
  })
})
