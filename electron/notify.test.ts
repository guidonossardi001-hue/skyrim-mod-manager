import { describe, it, expect, vi } from 'vitest'

// notify.ts importa Notification/BrowserWindow da 'electron' (solo per realNotifyIo, mai
// usato nei test del nucleo puro) — stub minimo così il modulo è caricabile fuori da Electron.
vi.mock('electron', () => ({
  Notification: class {
    static isSupported = () => true
    show() {}
  },
}))

import { notifyIfUnfocused, notifyWindowIfUnfocused, type NotifyIo } from './notify'

function fakeIo(overrides: Partial<NotifyIo> = {}): NotifyIo & { shown: { title: string; body: string }[] } {
  const shown: { title: string; body: string }[] = []
  return {
    shown,
    isSupported: () => true,
    show: (opts) => shown.push(opts),
    ...overrides,
  }
}

describe('notifyIfUnfocused', () => {
  it('finestra a fuoco → nessuna notifica (il toast in-app basta)', () => {
    const io = fakeIo()
    const shown = notifyIfUnfocused(true, { title: 'T', body: 'B' }, io)
    expect(shown).toBe(false)
    expect(io.shown).toHaveLength(0)
  })

  it('finestra non a fuoco → notifica mostrata', () => {
    const io = fakeIo()
    const shown = notifyIfUnfocused(false, { title: 'Crash rilevato', body: 'dettagli' }, io)
    expect(shown).toBe(true)
    expect(io.shown).toEqual([{ title: 'Crash rilevato', body: 'dettagli' }])
  })

  it('sistema senza supporto notifiche → nessuna notifica, mai throw', () => {
    const io = fakeIo({ isSupported: () => false })
    expect(notifyIfUnfocused(false, { title: 'T', body: 'B' }, io)).toBe(false)
    expect(io.shown).toHaveLength(0)
  })

  it('show() che lancia → mai propagato, ritorna false', () => {
    const io = fakeIo({
      show: () => {
        throw new Error('OS notification API unavailable')
      },
    })
    expect(() => notifyIfUnfocused(false, { title: 'T', body: 'B' }, io)).not.toThrow()
    expect(notifyIfUnfocused(false, { title: 'T', body: 'B' }, io)).toBe(false)
  })
})

describe('notifyWindowIfUnfocused', () => {
  const win = (focused: boolean, destroyed = false) =>
    ({
      isFocused: () => focused,
      isDestroyed: () => destroyed,
    }) as unknown as Parameters<typeof notifyWindowIfUnfocused>[0]

  it('finestra a fuoco → nessuna notifica', () => {
    const io = fakeIo()
    expect(notifyWindowIfUnfocused(win(true), { title: 'T', body: 'B' }, io)).toBe(false)
    expect(io.shown).toHaveLength(0)
  })

  it('finestra non a fuoco → notifica mostrata', () => {
    const io = fakeIo()
    expect(notifyWindowIfUnfocused(win(false), { title: 'T', body: 'B' }, io)).toBe(true)
    expect(io.shown).toHaveLength(1)
  })

  it('finestra distrutta → trattata come non a fuoco (notifica mostrata)', () => {
    const io = fakeIo()
    expect(notifyWindowIfUnfocused(win(true, true), { title: 'T', body: 'B' }, io)).toBe(true)
  })

  it('finestra assente (null/undefined) → trattata come non a fuoco', () => {
    const io = fakeIo()
    expect(notifyWindowIfUnfocused(null, { title: 'T', body: 'B' }, io)).toBe(true)
    expect(notifyWindowIfUnfocused(undefined, { title: 'T', body: 'B' }, io)).toBe(true)
  })

  it('isFocused() che lancia → mai propagato, trattata come non a fuoco', () => {
    const broken = {
      isFocused: () => {
        throw new Error('window destroyed mid-check')
      },
      isDestroyed: () => false,
    } as unknown as Parameters<typeof notifyWindowIfUnfocused>[0]
    const io = fakeIo()
    expect(() => notifyWindowIfUnfocused(broken, { title: 'T', body: 'B' }, io)).not.toThrow()
    expect(notifyWindowIfUnfocused(broken, { title: 'T', body: 'B' }, io)).toBe(true)
  })
})
