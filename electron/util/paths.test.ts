import { describe, it, expect } from 'vitest'
import { sanitizePathSegment } from './paths'

describe('sanitizePathSegment', () => {
  it('passes ordinary names through unchanged', () => {
    expect(sanitizePathSegment('SkyUI SE')).toBe('SkyUI SE')
    expect(sanitizePathSegment('Mod v1.2.3')).toBe('Mod v1.2.3')
  })

  it('replaces Windows-reserved characters with underscore', () => {
    expect(sanitizePathSegment('a/b\\c:d')).toBe('a_b_c_d')
    expect(sanitizePathSegment('what?*<>|"')).toBe('what_')
  })

  // Security: a renderer-supplied profile/mod name must never resolve outside its root.
  it('neutralizes directory-navigation segments (dir-escape defense)', () => {
    expect(sanitizePathSegment('..')).toBe('mod')
    expect(sanitizePathSegment('.')).toBe('mod')
    expect(sanitizePathSegment('  ..  ')).toBe('mod')
    expect(sanitizePathSegment('..', 'profile')).toBe('profile')
  })

  it('strips trailing dots/spaces that Windows would silently drop', () => {
    expect(sanitizePathSegment('Foo...')).toBe('Foo')
    expect(sanitizePathSegment('Foo ')).toBe('Foo')
  })

  it('rejects Windows reserved device names', () => {
    expect(sanitizePathSegment('CON')).toBe('mod')
    expect(sanitizePathSegment('nul.txt')).toBe('mod')
    expect(sanitizePathSegment('COM1')).toBe('mod')
    expect(sanitizePathSegment('lpt9')).toBe('mod')
    // A name merely CONTAINING a reserved token is fine.
    expect(sanitizePathSegment('Console')).toBe('Console')
  })

  it('collapses whitespace (incl. newlines) so a name cannot span/split a path', () => {
    expect(sanitizePathSegment('a\n\tb')).toBe('a b')
  })

  it('falls back on empty input', () => {
    expect(sanitizePathSegment('')).toBe('mod')
    expect(sanitizePathSegment('   ')).toBe('mod')
  })
})
