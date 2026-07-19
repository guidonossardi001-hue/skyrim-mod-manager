import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyEngineFixesConfig,
  classifyEngineFixesDll,
  engineFixesProtectedFiles,
  engineFixesVersionChangeWarning,
  injectEngineFixesConfigFile,
  setEngineFixesLock,
  ENGINE_FIXES_FORCED_CONFIG,
} from './engineFixesConfig'
import { buildFakeSkseDll, buildPluginVersionData, packVersion } from '../launch/peFixture'

// Snippet nello stesso layout REALE di EngineFixes.toml (sezioni [Patches]/[Fixes], `key = value`,
// booleani letterali true/false, commenti inline #).
const TOML = `# SSE Engine Fixes config
[EngineFixes]
VerboseLogging = false                  # Add extra log messages

[Patches]
FormCaching = true                      # speeds up the global form table
MaxStdio = 2048                         # Sets the maximum number of open file handles (default 512)
MemoryManager = true                    # Replaces Skyrim's global allocator
WaterflowSpeed = 20.0                   # 20.0 = default

[Fixes]
CellInit = true                         # Fixes a rare crash
`

describe('applyEngineFixesConfig — scrittura .toml struttura-preservante', () => {
  it('forza MaxStdio=8192 e MemoryManager=true preservando commenti e altre chiavi', () => {
    const out = applyEngineFixesConfig(TOML)
    // Valore critico cambiato, commento inline preservato.
    expect(out).toMatch(/^MaxStdio = 8192\s+# Sets the maximum number of open file handles/m)
    expect(out).toMatch(/^MemoryManager = true\s+# Replaces Skyrim's global allocator/m)
    // Tutto il resto intatto.
    expect(out).toContain('FormCaching = true                      # speeds up the global form table')
    expect(out).toContain('WaterflowSpeed = 20.0')
    expect(out).toContain('[EngineFixes]')
    expect(out).toContain('VerboseLogging = false')
    expect(out).toContain('[Fixes]')
    expect(out).toContain('CellInit = true')
    expect(out.startsWith('# SSE Engine Fixes config')).toBe(true)
  })

  it('serializza i booleani come true/false (TOML), MAI come 1/0 (INI)', () => {
    const out = applyEngineFixesConfig(TOML)
    expect(out).not.toMatch(/MemoryManager\s*=\s*[01]\b/)
    expect(out).toMatch(/MemoryManager = true/)
    // I numeri restano nudi (non quotati).
    expect(out).toMatch(/MaxStdio = 8192(?!["'])/)
  })

  it('idempotente: applicare due volte dà lo stesso risultato', () => {
    const once = applyEngineFixesConfig(TOML)
    expect(applyEngineFixesConfig(once)).toBe(once)
  })

  it('aggiunge sezione/chiave se assenti (file senza [Patches])', () => {
    const out = applyEngineFixesConfig('[Fixes]\nCellInit = true\n')
    expect(out).toContain('[Patches]')
    expect(out).toMatch(/MaxStdio = 8192/)
    expect(out).toMatch(/MemoryManager = true/)
    expect(out).toContain('CellInit = true') // sezione preesistente intatta
  })

  it('la config forzata di default imposta esattamente MaxStdio e MemoryManager in [Patches]', () => {
    expect(ENGINE_FIXES_FORCED_CONFIG).toEqual({ Patches: { MaxStdio: 8192, MemoryManager: true } })
  })
})

describe('classifyEngineFixesDll — validazione versione contro il runtime', () => {
  const efDll = (compat: number[], flags: { addressLibrary?: boolean } = {}) =>
    buildFakeSkseDll({
      exports: [
        {
          name: 'SKSEPlugin_Version',
          data: buildPluginVersionData({
            pluginVersion: packVersion(6, 1, 1, 0),
            name: 'SSE Engine Fixes',
            compatibleVersions: compat,
            ...flags,
          }),
        },
        { name: 'SKSEPlugin_Load' },
      ],
    })

  it('runtime dichiarato compatibile → ok', () => {
    const r = classifyEngineFixesDll(efDll([packVersion(1, 6, 1170, 0)]), '1.6.1170.0')
    expect(r.verdict).toBe('ok')
    expect(r.compatibleVersions).toContain('1.6.1170.0')
    expect(r.pluginVersion).toBe('6.1.1.0')
  })

  it('DLL SE (1.5.97) su gioco AE 1.6.1170 → incompatible (il bug reale che ha rotto po3/FLM)', () => {
    const r = classifyEngineFixesDll(efDll([packVersion(1, 5, 97, 0)]), '1.6.1170.0')
    expect(r.verdict).toBe('incompatible')
    expect(r.runtimeVersion).toBe('1.6.1170.0')
  })

  it('flag Address Library (version-independent) → ok anche se il runtime non è elencato', () => {
    const r = classifyEngineFixesDll(efDll([], { addressLibrary: true }), '1.6.1170.0')
    expect(r.verdict).toBe('ok')
  })

  it('DLL illeggibile/non-PE → unknown (mai un blocco spurio)', () => {
    const r = classifyEngineFixesDll(Buffer.from('non un PE'), '1.6.1170.0')
    expect(r.verdict).toBe('unknown')
  })
})

describe('engineFixesProtectedFiles — lista lockdown', () => {
  it('include Part 1 (DLL + toml in Data/SKSE/Plugins) e Part 2 (preloader in root)', () => {
    const files = engineFixesProtectedFiles('/game/Data', '/game')
    expect(files).toContain(join('/game/Data', 'SKSE', 'Plugins', 'EngineFixes.dll'))
    expect(files).toContain(join('/game/Data', 'SKSE', 'Plugins', 'EngineFixes.toml'))
    expect(files).toContain(join('/game', 'd3dx9_42.dll'))
    expect(files).toContain(join('/game', 'tbbmalloc.dll'))
  })

  it('senza gameDir include solo la Part 1 (istanza dedicata, nessuna root da proteggere)', () => {
    const files = engineFixesProtectedFiles('/inst/Data', null)
    expect(files).toHaveLength(2)
    expect(files.every((f) => f.includes('SKSE'))).toBe(true)
  })
})

describe('engineFixesVersionChangeWarning — guard cambio versione Part 1', () => {
  it('versione diversa -> avviso visibile con entrambe le versioni e la Part 2', () => {
    // Il caso reale: swap 6.1.1.0 → 7.0.20.0 col preloader root rimasto 6.1.1.
    const w = engineFixesVersionChangeWarning('6.1.1.0', '7.0.20.0')
    expect(w).toMatch(/^\[WARNING\] EngineFixes Part 1 aggiornata da v6\.1\.1\.0 a v7\.0\.20\.0/)
    expect(w).toContain('Part 2')
    expect(w).toContain('ROOT del gioco')
    expect(w).toContain('crasherà')
  })

  it('stessa versione -> null (nessun avviso spurio a ogni deploy)', () => {
    expect(engineFixesVersionChangeWarning('6.1.1.0', '6.1.1.0')).toBeNull()
  })

  it('non confrontabile (primo deploy / PE senza versione) -> null', () => {
    expect(engineFixesVersionChangeWarning(null, '7.0.20.0')).toBeNull()
    expect(engineFixesVersionChangeWarning('6.1.1.0', null)).toBeNull()
    expect(engineFixesVersionChangeWarning(null, null)).toBeNull()
  })
})

describe('injectEngineFixesConfigFile + setEngineFixesLock — round-trip su disco', () => {
  it('scrive la config nel file reale e la protegge/sprotegge read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-'))
    try {
      const toml = join(dir, 'EngineFixes.toml')
      writeFileSync(toml, TOML)

      const res = injectEngineFixesConfigFile(toml)
      expect(res.written).toBe(true)
      expect(res.existed).toBe(true)
      expect(readFileSync(toml, 'utf8')).toMatch(/MaxStdio = 8192/)

      // Idempotente: seconda iniezione non riscrive (nessun cambiamento).
      expect(injectEngineFixesConfigFile(toml).written).toBe(false)

      // Lockdown: read-only, poi sblocco.
      const locked = setEngineFixesLock([toml], true)
      expect(locked.locked).toBe(1)
      expect(statSync(toml).mode & 0o200).toBe(0) // bit di scrittura assente
      const unlocked = setEngineFixesLock([toml], false)
      expect(unlocked.locked).toBe(1)
      expect(statSync(toml).mode & 0o200).not.toBe(0)
    } finally {
      // Assicura che i file non restino read-only e la dir venga rimossa.
      setEngineFixesLock([join(dir, 'EngineFixes.toml')], false)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('file assente → lo crea con le sole chiavi forzate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-'))
    try {
      const toml = join(dir, 'EngineFixes.toml')
      const res = injectEngineFixesConfigFile(toml)
      expect(res.written).toBe(true)
      expect(res.existed).toBe(false)
      const content = readFileSync(toml, 'utf8')
      expect(content).toContain('[Patches]')
      expect(content).toMatch(/MaxStdio = 8192/)
      expect(content).toMatch(/MemoryManager = true/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('setEngineFixesLock salta i file assenti senza errore', () => {
    const res = setEngineFixesLock([join(tmpdir(), 'non-esiste-ef-xyz.dll')], true)
    expect(res.locked).toBe(0)
    expect(res.errors).toHaveLength(0)
  })
})
