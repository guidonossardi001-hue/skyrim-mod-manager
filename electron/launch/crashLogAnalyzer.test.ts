import { describe, it, expect } from 'vitest'
import { parseCrashLog, findProbableCulprit, analyzeCrashLog, type CallStackFrame } from './crashLogAnalyzer'

// Fixture nello stesso layout REALE di Crash Logger SSE/AE/VR (verificato su un log pubblico
// reale): header, PROBABLE CALL STACK, SKSE PLUGINS, PLUGINS con indice esadecimale.
const SAMPLE_LOG = `Skyrim SSE v1.6.1170
CrashLoggerSSE v1-12-1-0 Dec 22 2023 02:20:56

Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF7D8C71006 SkyrimSE.exe+0CD1006	mov rcx, [rbp+rax*8+0x60]

SYSTEM SPECS:
	OS: Microsoft Windows 11 Home v10.0.22621
	CPU: GenuineIntel 12th Gen Intel(R) Core(TM) i7-12700H

PROBABLE CALL STACK:
	[0] 0x7FF7D8C71006 SkyrimSE.exe+0CD1006 -> 68551+0xB6	mov rcx, [rbp+rax*8+0x60]
	[1] 0x7FF88C840123 SurvivalModeImproved.dll+0000123	test al, al
	[2] 0x7FF7D8F3FABA SkyrimSE.exe+0F9FABA -> 82082+0x63A	mov rbx, rax
	[3] 0x7FF95661257D KERNEL32.DLL+001257D
	[4] 0x7FF95872AA58    ntdll.dll+005AA58

REGISTERS:
	RAX 0x5243535C         (size_t) [1380143964]

SKSE PLUGINS:
	EngineFixes.dll v6.1.1
	SurvivalModeImproved.dll v2.0.1
	JContainers64.dll v4.2.8

PLUGINS:
	Light: 2	Regular: 3	Total: 5
	[ 0]     Skyrim.esm
	[ 1]     Update.esm
	[ 2]     Dawnguard.esm
	[ 3]     SurvivalModeImproved.esp
	[ 4]     JContainers.esp
`

describe('parseCrashLog', () => {
  it('estrae header, eccezione, call stack, plugin SKSE e plugin del load order', () => {
    const r = parseCrashLog(SAMPLE_LOG)
    expect(r.recognized).toBe(true)
    expect(r.gameVersion).toBe('Skyrim SSE v1.6.1170')
    expect(r.crashLoggerVersion).toMatch(/CrashLoggerSSE/)
    expect(r.exceptionType).toBe('EXCEPTION_ACCESS_VIOLATION')
    expect(r.exceptionModule).toBe('SkyrimSE.exe')
    expect(r.callStack).toHaveLength(5)
    expect(r.callStack[1]).toEqual({
      index: 1,
      address: '0x7FF88C840123',
      module: 'SurvivalModeImproved.dll',
      offset: '0000123',
      instruction: 'test al, al',
    })
    expect(r.ssePlugins).toEqual([
      { name: 'EngineFixes.dll', version: '6.1.1' },
      { name: 'SurvivalModeImproved.dll', version: '2.0.1' },
      { name: 'JContainers64.dll', version: '4.2.8' },
    ])
    expect(r.plugins).toEqual(['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'SurvivalModeImproved.esp', 'JContainers.esp'])
  })

  it('testo estraneo -> recognized:false, sezioni vuote, mai un throw', () => {
    const r = parseCrashLog('questo non è affatto un crash log di Skyrim')
    expect(r.recognized).toBe(false)
    expect(r.callStack).toEqual([])
    expect(r.plugins).toEqual([])
    expect(r.gameVersion).toBeNull()
  })

  it('stringa vuota -> nessun throw', () => {
    expect(parseCrashLog('').recognized).toBe(false)
  })
})

describe('findProbableCulprit', () => {
  it('salta i moduli di sistema/engine e trova il primo modulo terze parti', () => {
    const stack: CallStackFrame[] = [
      { index: 0, address: '0x1', module: 'SkyrimSE.exe', offset: '1', instruction: null },
      { index: 1, address: '0x2', module: 'SomeMod.dll', offset: '2', instruction: null },
      { index: 2, address: '0x3', module: 'ntdll.dll', offset: '3', instruction: null },
    ]
    expect(findProbableCulprit(stack)?.module).toBe('SomeMod.dll')
  })
  it('null se la call stack è vuota o coinvolge solo moduli di sistema', () => {
    expect(findProbableCulprit([])).toBeNull()
    expect(
      findProbableCulprit([{ index: 0, address: '0x1', module: 'ntdll.dll', offset: '1', instruction: null }]),
    ).toBeNull()
  })
})

describe('analyzeCrashLog', () => {
  it('identifica il modulo colpevole reale (SurvivalModeImproved.dll) dal sample', () => {
    const r = parseCrashLog(SAMPLE_LOG)
    const a = analyzeCrashLog(r)
    expect(a.culprit?.module).toBe('SurvivalModeImproved.dll')
    expect(a.suggestions.some((s) => s.includes('SurvivalModeImproved.dll'))).toBe(true)
  })

  it('nessun modulo terze parti -> suggerimento generico su corruzione/hardware', () => {
    const r = parseCrashLog(SAMPLE_LOG.replace('SurvivalModeImproved.dll+0000123\ttest al, al', 'ntdll.dll+0000123\ttest al, al'))
    const a = analyzeCrashLog(r)
    expect(a.culprit).toBeNull()
    expect(a.suggestions.some((s) => s.includes('corruzione'))).toBe(true)
  })

  it('EXCEPTION_STACK_OVERFLOW aggiunge il suggerimento sui cicli Papyrus', () => {
    const r = parseCrashLog(SAMPLE_LOG.replace('EXCEPTION_ACCESS_VIOLATION', 'EXCEPTION_STACK_OVERFLOW'))
    const a = analyzeCrashLog(r)
    expect(a.suggestions.some((s) => s.includes('Papyrus'))).toBe(true)
  })

  it('nessun plugin SKSE caricato -> suggerimento su SKSE/Address Library', () => {
    const noSse = SAMPLE_LOG.replace(/SKSE PLUGINS:[\s\S]*?PLUGINS:/, 'PLUGINS:')
    const r = parseCrashLog(noSse)
    const a = analyzeCrashLog(r)
    expect(a.suggestions.some((s) => s.includes('Address Library'))).toBe(true)
  })
})
