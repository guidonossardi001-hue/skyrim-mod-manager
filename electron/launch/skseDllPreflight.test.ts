import { describe, it, expect } from 'vitest'
import { classifySkseDll, unpackVersion } from './skseDllPreflight'
import { buildFakeSkseDll, buildPluginVersionData, packVersion } from './peFixture'

describe('unpackVersion', () => {
  it('decodifica major/minor/patch/build dal formato REL::Version::pack', () => {
    expect(unpackVersion(packVersion(1, 6, 1170, 0))).toBe('1.6.1170.0')
    expect(unpackVersion(packVersion(1, 6, 640, 0))).toBe('1.6.640.0')
  })
})

describe('classifySkseDll', () => {
  it('non un PE → unknown', () => {
    expect(classifySkseDll(Buffer.from('junk')).verdict).toBe('unknown')
  })

  it('Machine non-x64 → incompatible (probabile DLL Oldrim/32-bit)', () => {
    const dll = buildFakeSkseDll({ machine: 0x14c, exports: [] })
    const r = classifySkseDll(dll)
    expect(r.verdict).toBe('incompatible')
    expect(r.reason).toMatch(/32-bit|Machine/)
  })

  it('nessun export SKSEPlugin_Version → unknown ma non incompatibile', () => {
    const dll = buildFakeSkseDll({ exports: [{ name: 'SKSEPlugin_Load' }] })
    const r = classifySkseDll(dll)
    expect(r.verdict).toBe('unknown')
    expect(r.hasLoadExport).toBe(true)
  })

  it('struct valida + runtime compatibile dichiarato → ok', () => {
    const versionData = buildPluginVersionData({
      name: 'TestPlugin',
      author: 'Tester',
      pluginVersion: packVersion(1, 2, 3, 4),
      compatibleVersions: [packVersion(1, 6, 1170, 0)],
    })
    const dll = buildFakeSkseDll({
      exports: [{ name: 'SKSEPlugin_Load' }, { name: 'SKSEPlugin_Version', data: versionData }],
    })
    const r = classifySkseDll(dll, '1.6.1170.0')
    expect(r.verdict).toBe('ok')
    expect(r.data?.name).toBe('TestPlugin')
    expect(r.data?.author).toBe('Tester')
    expect(r.data?.pluginVersion).toBe('1.2.3.4')
    expect(r.data?.compatibleVersions).toEqual(['1.6.1170.0'])
    expect(r.hasLoadExport).toBe(true)
  })

  it('runtime NON tra le versioni compatibili e nessun flag version-independent → incompatible', () => {
    const versionData = buildPluginVersionData({ compatibleVersions: [packVersion(1, 6, 640, 0)] })
    const dll = buildFakeSkseDll({ exports: [{ name: 'SKSEPlugin_Version', data: versionData }] })
    const r = classifySkseDll(dll, '1.6.1170.0')
    expect(r.verdict).toBe('incompatible')
    expect(r.reason).toMatch(/1\.6\.1170\.0/)
  })

  it('runtime non tra le compatibili MA addressLibrary version-independent → ok', () => {
    const versionData = buildPluginVersionData({
      compatibleVersions: [packVersion(1, 6, 640, 0)],
      addressLibrary: true,
    })
    const dll = buildFakeSkseDll({ exports: [{ name: 'SKSEPlugin_Version', data: versionData }] })
    const r = classifySkseDll(dll, '1.6.1170.0')
    expect(r.verdict).toBe('ok')
    expect(r.data?.addressLibrary).toBe(true)
  })

  it('senza runtimeVersion non giudica compatibleVersions (solo struct)', () => {
    const versionData = buildPluginVersionData({ compatibleVersions: [packVersion(1, 6, 640, 0)] })
    const dll = buildFakeSkseDll({ exports: [{ name: 'SKSEPlugin_Version', data: versionData }] })
    expect(classifySkseDll(dll).verdict).toBe('ok')
  })

  it('dataVersion sconosciuto → warning', () => {
    const versionData = buildPluginVersionData({ dataVersion: 99 })
    const dll = buildFakeSkseDll({ exports: [{ name: 'SKSEPlugin_Version', data: versionData }] })
    expect(classifySkseDll(dll).verdict).toBe('warning')
  })

  it('nessuna export table (DataDirectory[0] vuota) → unknown', () => {
    const dll = buildFakeSkseDll({ exports: [{ name: 'SKSEPlugin_Version' }], noExportTable: true })
    expect(classifySkseDll(dll).verdict).toBe('unknown')
  })
})
