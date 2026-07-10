import { describe, it, expect } from 'vitest'
import { SEVENZIP_LICENSE, THIRD_PARTY_LICENSES } from './licenses'

// Compliance guard: the bundled 7-Zip license text must reproduce every clause the
// distribution terms require, so a future edit can't silently truncate it.
describe('bundled 7-Zip license (LGPL + unRAR compliance)', () => {
  it('reproduces the mandatory redistribution clause', () => {
    expect(SEVENZIP_LICENSE).toContain('Redistributions in binary form must reproduce related license information from this file')
  })

  it('includes the GNU LGPL grant', () => {
    expect(SEVENZIP_LICENSE).toContain('GNU Lesser General Public')
    expect(SEVENZIP_LICENSE).toMatch(/version 2\.1 of the License/)
  })

  it('includes the unRAR license restriction in full', () => {
    expect(SEVENZIP_LICENSE).toContain('unRAR license restriction')
    expect(SEVENZIP_LICENSE).toContain('may\n      not be used to develop a RAR (WinRAR) compatible archiver')
    expect(SEVENZIP_LICENSE).toContain('Alexander Roshal')
  })

  it('includes the BSD 3-clause attribution', () => {
    expect(SEVENZIP_LICENSE).toContain('BSD 3-clause License')
    expect(SEVENZIP_LICENSE).toContain('Apple Inc')
  })

  it('retains the copyright line', () => {
    expect(SEVENZIP_LICENSE).toContain('7-Zip Copyright (C) 1999-2026 Igor Pavlov')
  })
})

describe('third-party license list', () => {
  it('lists 7-Zip with its dual LGPL/unRAR license', () => {
    const z = THIRD_PARTY_LICENSES.find(l => l.name === '7-Zip')
    expect(z?.license).toMatch(/LGPL/)
    expect(z?.license).toMatch(/unRAR/)
  })
  it('attributes the other bundled components', () => {
    expect(THIRD_PARTY_LICENSES.map(l => l.name)).toEqual(
      expect.arrayContaining(['better-sqlite3', 'Electron', 'React', 'axios', 'adm-zip']),
    )
  })
})
