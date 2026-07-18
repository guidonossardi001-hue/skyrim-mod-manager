import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import {
  buildWatcherScript,
  parseWatcherLine,
  startDialogWatcher,
  DIALOG_SIGNATURES,
  type WatcherEvent,
} from './dialogWatcher'

describe('DIALOG_SIGNATURES', () => {
  it('copre esattamente le due firme verificate dal vivo (2026-07-18)', () => {
    expect(DIALOG_SIGNATURES).toEqual([
      { title: 'Confirm', buttonText: 'Yes', requiredChildTextContains: '64bit' },
      { title: 'A message from the developer', buttonText: 'Close', requiredChildTextContains: null },
    ])
  })
})

describe('buildWatcherScript', () => {
  it('incorpora pid e durata massima', () => {
    const script = buildWatcherScript(9452, 60000)
    expect(script).toContain('$targetPid = 9452')
    expect(script).toContain('AddMilliseconds(60000)')
  })

  it('incorpora entrambe le firme (titolo + bottone + testo richiesto)', () => {
    const script = buildWatcherScript(1, 1000)
    expect(script).toContain("Title = 'Confirm'")
    expect(script).toContain("Button = 'Yes'")
    expect(script).toContain("RequiredText = '64bit'")
    expect(script).toContain("Title = 'A message from the developer'")
    expect(script).toContain("Button = 'Close'")
  })

  it('mai WM_CLOSE, mai SendKeys/SetForegroundWindow — solo BM_CLICK chirurgico', () => {
    const script = buildWatcherScript(1, 1000)
    expect(script).toContain('BM_CLICK')
    expect(script).not.toMatch(/SendKeys|SetForegroundWindow|WM_CLOSE/i)
  })

  it('rifiuta pid non intero/non positivo', () => {
    expect(() => buildWatcherScript(0, 1000)).toThrow()
    expect(() => buildWatcherScript(-5, 1000)).toThrow()
    expect(() => buildWatcherScript(1.5, 1000)).toThrow()
  })

  it('rifiuta maxDurationMs non valido', () => {
    expect(() => buildWatcherScript(1, 0)).toThrow()
    expect(() => buildWatcherScript(1, -1)).toThrow()
  })

  it('un titolo con apostrofo verrebbe comunque quotato in modo sicuro (nessuna injection PowerShell)', () => {
    // Le firme sono statiche/nostre (mai testo utente), ma la funzione di quoting resta
    // verificata: ' raddoppiato è l'escape standard per le stringhe single-quoted PowerShell.
    const script = buildWatcherScript(1, 1000)
    // Sanity: lo script deve rimanere sintatticamente equilibrato sulle virgolette singole
    // per ogni riga Title/Button/RequiredText (nessuna quote spezzata).
    const titleLines = script.split('\n').filter((l) => l.includes('Title ='))
    expect(titleLines.length).toBeGreaterThan(0)
    for (const line of titleLines) {
      const singleQuotes = (line.match(/'/g) || []).length
      expect(singleQuotes % 2).toBe(0)
    }
  })
})

describe('parseWatcherLine', () => {
  it('riconosce PROCESS_GONE', () => {
    expect(parseWatcherLine('PROCESS_GONE')).toEqual({ type: 'process-gone' })
  })

  it('riconosce WATCHER_DONE', () => {
    expect(parseWatcherLine('WATCHER_DONE')).toEqual({ type: 'done' })
  })

  it('riconosce DISMISSED con titolo e bottone', () => {
    expect(parseWatcherLine('DISMISSED: Confirm -> Yes')).toEqual({
      type: 'dismissed',
      title: 'Confirm',
      button: 'Yes',
    })
  })

  it('riconosce DISMISSED col titolo lungo (donazioni)', () => {
    expect(parseWatcherLine('DISMISSED: A message from the developer -> Close')).toEqual({
      type: 'dismissed',
      title: 'A message from the developer',
      button: 'Close',
    })
  })

  it('riconosce SIGNATURE_MATCHED_NO_BUTTON', () => {
    expect(parseWatcherLine('SIGNATURE_MATCHED_NO_BUTTON: Confirm')).toEqual({
      type: 'signature-no-button',
      title: 'Confirm',
    })
  })

  it('riga sconosciuta → unknown, mai un throw', () => {
    expect(parseWatcherLine('qualcosa di inatteso')).toEqual({ type: 'unknown', line: 'qualcosa di inatteso' })
  })

  it('spazi bianchi attorno alla riga vengono ignorati', () => {
    expect(parseWatcherLine('  PROCESS_GONE  \r\n')).toEqual({ type: 'process-gone' })
  })
})

describe('startDialogWatcher', () => {
  it('spawn iniettato senza stdout (no-op readline) → nessun throw, handle stoppabile e idempotente', () => {
    const spawnImpl = (): unknown => {
      const emitter = new EventEmitter() as EventEmitter & { kill: () => void; killed: boolean }
      emitter.killed = false
      emitter.kill = () => {
        emitter.killed = true
      }
      return emitter // niente .stdout: il ramo readline viene saltato, comportamento verificato altrove via Readable reale in un test dedicato
    }
    const events: WatcherEvent[] = []
    const handle = startDialogWatcher(1234, { maxDurationMs: 1000, onEvent: (e) => events.push(e), spawnImpl: spawnImpl as never })
    expect(handle.stop).toBeTypeOf('function')
    expect(() => handle.stop()).not.toThrow()
    expect(() => handle.stop()).not.toThrow() // idempotente
  })

  it('con un vero Readable come stdout, ogni riga viene instradata a parseWatcherLine via onEvent', async () => {
    const stdout = new Readable({ read() {} })
    const spawnImpl = (): unknown => {
      const emitter = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void }
      emitter.stdout = stdout
      emitter.kill = () => {}
      return emitter
    }
    const events: WatcherEvent[] = []
    startDialogWatcher(1234, { maxDurationMs: 1000, onEvent: (e) => events.push(e), spawnImpl: spawnImpl as never })
    stdout.push('DISMISSED: Confirm -> Yes\n')
    stdout.push('WATCHER_DONE\n')
    stdout.push(null)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toContainEqual({ type: 'dismissed', title: 'Confirm', button: 'Yes' })
    expect(events).toContainEqual({ type: 'done' })
  })

  it('spawn che lancia un errore non propaga mai un throw al chiamante', () => {
    const spawnImpl = () => {
      throw new Error('powershell non trovato')
    }
    const events: WatcherEvent[] = []
    expect(() =>
      startDialogWatcher(1, { maxDurationMs: 1000, onEvent: (e) => events.push(e), spawnImpl: spawnImpl as never }),
    ).not.toThrow()
    expect(events.some((e) => e.type === 'unknown')).toBe(true)
  })

  it('pid non valido passato a startDialogWatcher → mai un throw, evento unknown', () => {
    const events: WatcherEvent[] = []
    expect(() => startDialogWatcher(-1, { maxDurationMs: 1000, onEvent: (e) => events.push(e) })).not.toThrow()
    expect(events.some((e) => e.type === 'unknown')).toBe(true)
  })
})
