import { describe, it, expect } from 'vitest'
import { planMissingFiles, expectedModDirName } from './missingFiles'

const row = (nexusId: number, fileId: number | null, name: string, sizeMb = 1, required = 1) => ({
  nexus_id: nexusId,
  nexus_file_id: fileId,
  name,
  size_mb: sizeMb,
  required,
})

describe('expectedModDirName', () => {
  it('replica lo schema di installManager: sanitizePathSegment su `<nexus_id>-<nome>` intero', () => {
    expect(expectedModDirName(266, 'USSEP')).toBe('266-USSEP')
    expect(expectedModDirName(5, 'A/B: C?')).toBe('5-A_B_ C_')
  })
})

describe('planMissingFiles', () => {
  it('accoda solo le coppie senza download né cartella estratta (il lavoro fatto non si rifà)', () => {
    const catalog = [
      row(100, 1, 'Main'), // già scaricato (completed)
      row(100, 2, 'ESP flagged as ESL'), // MANCANTE → in piano
      row(200, 5, 'Bruma Assets'), // già estratto su disco
      row(200, 6, 'Bruma Main'), // MANCANTE → in piano
    ]
    const downloads = [{ nexus_id: 100, file_id: 1, status: 'completed' }]
    const extracted = new Set([expectedModDirName(200, 'Bruma Assets')])
    const plan = planMissingFiles(catalog, downloads, (d) => extracted.has(d))
    expect(plan.map((p) => `${p.nexusId}:${p.fileId}`)).toEqual(['100:2', '200:6'])
  })

  it('salta le coppie già in coda/lavorazione ma RITENTA i failed', () => {
    const catalog = [row(1, 10, 'a'), row(2, 20, 'b'), row(3, 30, 'c')]
    const downloads = [
      { nexus_id: 1, file_id: 10, status: 'pending' },
      { nexus_id: 2, file_id: 20, status: 'downloading' },
      { nexus_id: 3, file_id: 30, status: 'failed' },
    ]
    const plan = planMissingFiles(catalog, downloads, () => false)
    expect(plan.map((p) => p.nexusId)).toEqual([3])
  })

  it('ignora righe senza coppia valida e deduplica le coppie ripetute', () => {
    const catalog = [
      row(1, null, 'senza file'),
      row(0, 5, 'modId zero'),
      { nexus_id: 7, nexus_file_id: 70, name: '  ', size_mb: 1, required: 1 },
      row(9, 90, 'ok'),
      row(9, 90, 'ok bis'), // stessa coppia
    ]
    const plan = planMissingFiles(catalog, [], () => false)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ nexusId: 9, fileId: 90, name: 'ok' })
  })

  it('converte size_mb in byte e propaga required', () => {
    const plan = planMissingFiles([row(1, 10, 'a', 3, 0)], [], () => false)
    expect(plan[0].sizeBytes).toBe(3 * 1024 * 1024)
    expect(plan[0].required).toBe(false)
  })
})
