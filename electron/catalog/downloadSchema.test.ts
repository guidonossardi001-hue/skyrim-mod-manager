import { describe, it, expect } from 'vitest'
import {
  validateQueueEntry,
  validateDownloadSchema,
  validateCatalogLinks,
  summarizeInvalid,
} from './downloadSchema'

const MD5 = 'fc03f90120ef30c209076aad66b8ffe7'

describe('validateQueueEntry', () => {
  it('entry completa → nessuna issue', () => {
    expect(validateQueueEntry({ modId: 151, fileId: 22253, name: 'Ok', md5: MD5, fileSize: 123 })).toEqual([])
  })
  it('modId/fileId mancanti o non validi → issue hard', () => {
    expect(validateQueueEntry({ fileId: 1, name: 'x' })).toContain('missing-mod-id')
    expect(validateQueueEntry({ modId: 0, fileId: 1 })).toContain('missing-mod-id')
    expect(validateQueueEntry({ modId: 1, name: 'x' })).toContain('missing-file-id')
    expect(validateQueueEntry({ modId: 1, fileId: 2.5 })).toContain('missing-file-id')
  })
  it('md5 malformato → bad-md5; md5 assente/vuoto è lecito', () => {
    expect(validateQueueEntry({ modId: 1, fileId: 2, md5: 'nothex' })).toContain('bad-md5')
    expect(validateQueueEntry({ modId: 1, fileId: 2, md5: '' })).toEqual([])
    expect(validateQueueEntry({ modId: 1, fileId: 2 })).toEqual([])
  })
  it('fileSize non finito/≤0 → bad-size (soft)', () => {
    expect(validateQueueEntry({ modId: 1, fileId: 2, fileSize: Number.NaN })).toContain('bad-size')
    expect(validateQueueEntry({ modId: 1, fileId: 2, fileSize: -1 })).toContain('bad-size')
  })
})

describe('validateDownloadSchema (fail-safe split)', () => {
  it('esclude le hard, tiene le soft con warning, non lancia mai', () => {
    const mods = [
      { modId: 1, fileId: 11, name: 'Valida', md5: MD5, fileSize: 10 },
      { modId: 2, fileId: undefined, name: 'Senza fileId' }, // hard → esclusa
      { modId: 3, fileId: 33, name: 'Md5 rotto', md5: 'xx' }, // hard → esclusa
      { modId: 4, fileId: 44, name: 'Size sospetta', fileSize: -9 }, // soft → resta
    ]
    const r = validateDownloadSchema(mods)
    expect(r.valid.map((m) => m.modId)).toEqual([1, 4])
    expect(r.invalid.map((e) => e.modId)).toEqual([2, 3])
    expect(r.invalid[0].issues).toContain('missing-file-id')
    expect(r.invalid[1].issues).toContain('bad-md5')
    expect(r.warnings.map((e) => e.modId)).toEqual([4])
  })
})

describe('validateCatalogLinks', () => {
  it('installabile con nexus_file_id O nexus_download_url http(s); altrimenti missing-url', () => {
    const rep = validateCatalogLinks([
      { nexus_id: 1, name: 'Con file id', nexus_file_id: 100, nexus_download_url: null },
      { nexus_id: 2, name: 'Con url', nexus_file_id: null, nexus_download_url: 'https://cdn/x.7z' },
      { nexus_id: 3, name: 'Url non http', nexus_file_id: null, nexus_download_url: 'file:///c/x' },
      { nexus_id: 4, name: 'Nudo', nexus_file_id: null, nexus_download_url: null },
      { nexus_id: 0, name: 'Id rotto', nexus_file_id: 5, nexus_download_url: null },
    ])
    expect(rep.checked).toBe(5)
    expect(rep.ok).toBe(2)
    expect(rep.missingUrl.map((r) => r.nexus_id)).toEqual([3, 4])
    expect(rep.badModId.map((r) => r.nexus_id)).toEqual([0])
  })
})

describe('summarizeInvalid', () => {
  it('cappa la lista e conta le rimanenti', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      modId: i + 1,
      name: `M${i + 1}`,
      issues: ['missing-file-id' as const],
    }))
    const s = summarizeInvalid(entries, 10)
    expect(s).toContain('+2 altre')
  })
})
