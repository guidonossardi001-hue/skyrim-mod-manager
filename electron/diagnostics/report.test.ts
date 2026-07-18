import { describe, it, expect } from 'vitest'
import { formatDiagnosticsReport, type DiagnosticsData } from './report'

const base: DiagnosticsData = {
  generatedAt: '2026-07-18T12:00:00Z',
  appVersion: '1.1.0',
  platform: 'win32',
  osRelease: '10.0.26200',
  cpuModel: 'AMD Ryzen 7 7800X3D',
  cpuCores: 8,
  ramGB: 16,
  gpuName: 'AMD Radeon RX 9070 XT',
  gpuVramGB: 16,
  steamInstalled: true,
  gamePath: 'C:\\Games\\Skyrim',
  gameVersion: '1.6.1170',
  sksePresent: true,
  skseVersion: '2.2.6',
  activeProfileName: 'Anime Fantasy Default',
  modsTotal: 1739,
  modsEnabled: 1739,
  modsInstalled: 1739,
  deployChecked: true,
  deployMissing: 0,
  deployReplaced: 0,
  deployJunctionsMissing: 0,
  lastCrashLog: null,
}

describe('formatDiagnosticsReport', () => {
  it('include tutti i campi principali quando i dati sono completi', () => {
    const r = formatDiagnosticsReport(base)
    expect(r).toContain('v1.1.0')
    expect(r).toContain('win32 10.0.26200')
    expect(r).toContain('AMD Ryzen 7 7800X3D (8 core)')
    expect(r).toContain('16 GB')
    expect(r).toContain('AMD Radeon RX 9070 XT — 16 GB VRAM')
    expect(r).toContain('Steam: rilevato')
    expect(r).toContain('C:\\Games\\Skyrim (v1.6.1170)')
    expect(r).toContain('SKSE: presente v2.2.6')
    expect(r).toContain('Anime Fantasy Default')
    expect(r).toContain('1739/1739 abilitate, 1739 installate')
    expect(r).toContain('Deploy: verificato — 0 mancanti, 0 sostituiti esternamente, 0 junction scollegate')
  })

  it('dati mancanti (probe falliti) → placeholder leggibili, mai "null"/"undefined" letterali', () => {
    const r = formatDiagnosticsReport({
      ...base,
      cpuModel: null,
      ramGB: null,
      gpuName: null,
      gpuVramGB: null,
      gamePath: null,
      gameVersion: null,
      sksePresent: false,
      skseVersion: null,
      activeProfileName: null,
    })
    expect(r).not.toContain('null')
    expect(r).not.toContain('undefined')
    expect(r).toContain('CPU: sconosciuta')
    expect(r).toContain('RAM: sconosciuta')
    expect(r).toContain('GPU: sconosciuta')
    expect(r).toContain('Skyrim: NON rilevato')
    expect(r).toContain('SKSE: ASSENTE')
    expect(r).toContain('Profilo attivo: sconosciuto')
  })

  it('deploy mai verificato → riga esplicita, non conteggi a zero fuorvianti', () => {
    const r = formatDiagnosticsReport({ ...base, deployChecked: false })
    expect(r).toContain('Deploy: nessun manifest verificabile (mai deployato, o già purgato)')
    expect(r).not.toContain('0 mancanti')
  })

  it('deploy con drift → conteggi riportati fedelmente', () => {
    const r = formatDiagnosticsReport({
      ...base,
      deployMissing: 2,
      deployReplaced: 1,
      deployJunctionsMissing: 3,
    })
    expect(r).toContain('2 mancanti, 1 sostituiti esternamente, 3 junction scollegate')
  })

  it('crash log presente → riportato; assente → riga omessa del tutto', () => {
    const withCrash = formatDiagnosticsReport({ ...base, lastCrashLog: 'crash-2026-07-18.log' })
    expect(withCrash).toContain('Ultimo crash notificato: crash-2026-07-18.log')
    const withoutCrash = formatDiagnosticsReport({ ...base, lastCrashLog: null })
    expect(withoutCrash).not.toContain('Ultimo crash')
  })
})
