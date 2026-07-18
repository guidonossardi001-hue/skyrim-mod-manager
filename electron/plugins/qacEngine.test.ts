import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runQuickAutoClean } from './qacEngine'

/** Fake child process: espone .on/.kill come una ChildProcess reale, senza spawnare nulla. */
function fakeSpawn(onSpawned: (emitter: EventEmitter & { killed: boolean }) => void) {
  return (): unknown => {
    const emitter = new EventEmitter() as EventEmitter & { killed: boolean }
    emitter.killed = false
    ;(emitter as unknown as { kill: () => void }).kill = () => {
      emitter.killed = true
    }
    setTimeout(() => onSpawned(emitter), 0)
    return emitter
  }
}

describe('runQuickAutoClean', () => {
  it('rifiuta un master ufficiale senza spawnare nulla', async () => {
    const r = await runQuickAutoClean({ xeditPath: 'C:/nope/SSEEdit.exe', dataPath: 'C:/Game/Data', pluginName: 'Skyrim.esm' })
    expect(r.verdict).toBe('blocked')
  })

  it('xEdit non trovato → launch-failed', async () => {
    const r = await runQuickAutoClean({ xeditPath: 'C:/percorso/inesistente/SSEEdit.exe', dataPath: 'C:/Game/Data', pluginName: 'Patch.esp' })
    expect(r.verdict).toBe('launch-failed')
  })

  it('run riuscito: il fake process scrive il log e esce → cleaned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      const spawnImpl = fakeSpawn((emitter) => {
        // Il "processo" scrive il log come farebbe xEdit reale all'uscita, poi emette 'exit'.
        writeFile(join(dir, 'SSEEdit_log.txt'), 'Removing: [ARMO:0002] bar\n').then(() => emitter.emit('exit', 0))
      })
      const r = await runQuickAutoClean({
        xeditPath,
        dataPath: 'C:/Game/Data',
        pluginName: 'Patch.esp',
        postExitFlushMs: 5,
        spawnImpl: spawnImpl as never,
      })
      expect(r.verdict).toBe('cleaned')
      expect(r.log?.removed).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('nessuna riga di pulizia nel log → nothing-to-clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      const spawnImpl = fakeSpawn((emitter) => {
        writeFile(join(dir, 'SSEEdit_log.txt'), 'Loading plugin...\nDone.\n').then(() => emitter.emit('exit', 0))
      })
      const r = await runQuickAutoClean({ xeditPath, dataPath: 'C:/Game/Data', pluginName: 'Patch.esp', postExitFlushMs: 5, spawnImpl: spawnImpl as never })
      expect(r.verdict).toBe('nothing-to-clean')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exception log presente dopo l-uscita → crashed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      const spawnImpl = fakeSpawn((emitter) => {
        writeFile(join(dir, 'SSEEditException.log'), 'access violation\n').then(() => emitter.emit('exit', 1))
      })
      const r = await runQuickAutoClean({ xeditPath, dataPath: 'C:/Game/Data', pluginName: 'Patch.esp', postExitFlushMs: 5, spawnImpl: spawnImpl as never })
      expect(r.verdict).toBe('crashed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('timeout: processo mai in uscita → timeout e kill invocato', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      let killed = false
      const spawnImpl = () => {
        const emitter = new EventEmitter() as EventEmitter & { kill: () => void }
        emitter.kill = () => {
          killed = true
          // Simula il processo che effettivamente termina dopo il kill.
          setTimeout(() => emitter.emit('exit', null), 0)
        }
        return emitter
      }
      const r = await runQuickAutoClean({
        xeditPath,
        dataPath: 'C:/Game/Data',
        pluginName: 'Patch.esp',
        timeoutMs: 5,
        postExitFlushMs: 5,
        spawnImpl: spawnImpl as never,
      })
      expect(killed).toBe(true)
      expect(r.verdict).toBe('timeout')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('avvia il watcher dialog col PID del processo xEdit e lo ferma allo exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      let stopped = false
      const watcherCalls: { pid: number; maxDurationMs: number }[] = []
      const dialogWatcherImpl = ((pid: number, o: { maxDurationMs: number }) => {
        watcherCalls.push({ pid, maxDurationMs: o.maxDurationMs })
        return { stop: () => (stopped = true) }
      }) as never
      const spawnImpl = (): unknown => {
        const emitter = new EventEmitter() as EventEmitter & { pid: number; kill: () => void }
        emitter.pid = 4242
        emitter.kill = () => {}
        setTimeout(() => {
          writeFile(join(dir, 'SSEEdit_log.txt'), '').then(() => emitter.emit('exit', 0))
        }, 0)
        return emitter
      }
      const r = await runQuickAutoClean({
        xeditPath,
        dataPath: 'C:/Game/Data',
        pluginName: 'Patch.esp',
        timeoutMs: 9999,
        postExitFlushMs: 5,
        spawnImpl: spawnImpl as never,
        dialogWatcherImpl,
      })
      expect(r.verdict).toBe('nothing-to-clean')
      expect(watcherCalls).toEqual([{ pid: 4242, maxDurationMs: 9999 }])
      expect(stopped).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('dialogWatcherEnabled:false → il watcher non viene mai avviato', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      let watcherStarted = false
      const dialogWatcherImpl = (() => {
        watcherStarted = true
        return { stop: () => {} }
      }) as never
      const spawnImpl = (): unknown => {
        const emitter = new EventEmitter() as EventEmitter & { pid: number; kill: () => void }
        emitter.pid = 4242
        emitter.kill = () => {}
        setTimeout(() => emitter.emit('exit', 0), 0)
        return emitter
      }
      await runQuickAutoClean({
        xeditPath,
        dataPath: 'C:/Game/Data',
        pluginName: 'Patch.esp',
        postExitFlushMs: 5,
        spawnImpl: spawnImpl as never,
        dialogWatcherEnabled: false,
        dialogWatcherImpl,
      })
      expect(watcherStarted).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('senza pid sul processo spawnato (fake senza .pid) → il watcher non viene avviato, mai un crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    try {
      let watcherStarted = false
      const dialogWatcherImpl = (() => {
        watcherStarted = true
        return { stop: () => {} }
      }) as never
      const spawnImpl = fakeSpawn((emitter) => emitter.emit('exit', 0)) // fakeSpawn non imposta .pid
      const r = await runQuickAutoClean({
        xeditPath,
        dataPath: 'C:/Game/Data',
        pluginName: 'Patch.esp',
        postExitFlushMs: 5,
        spawnImpl: spawnImpl as never,
        dialogWatcherImpl,
      })
      expect(watcherStarted).toBe(false)
      expect(r.verdict).toBe('crashed') // nessun log scritto: comportamento invariato
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('log stantio da un run precedente viene ignorato (cancellato prima del lancio)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qac-test-'))
    const xeditPath = join(dir, 'SSEEdit.exe')
    await writeFile(xeditPath, '')
    await writeFile(join(dir, 'SSEEdit_log.txt'), 'Removing: [STALE:0000] old\n')
    try {
      const spawnImpl = fakeSpawn((emitter) => {
        // Il nuovo run non scrive nulla: il log stantio NON deve sopravvivere.
        emitter.emit('exit', 0)
      })
      const r = await runQuickAutoClean({ xeditPath, dataPath: 'C:/Game/Data', pluginName: 'Patch.esp', postExitFlushMs: 5, spawnImpl: spawnImpl as never })
      expect(r.verdict).toBe('crashed') // nessun log scritto da QUESTO run = log mai scritto
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
