import { describe, it, expect } from 'vitest'
import { runPreflight, preflightSummary } from './preflight'
import type { AppSettings, Mod } from '@/types'

const baseSettings: AppSettings = {
  language: 'it',
  theme: 'dark',
  autoSort: true,
  checkConflicts: true,
  autoBackup: true,
  downloadThreads: 4,
}

function modNamed(name: string, enabled = true): Mod {
  return {
    id: 1,
    profile_id: 1,
    nexus_id: 1,
    name,
    version: null,
    author: null,
    category: 'framework',
    description: null,
    file_size: 0,
    install_path: null,
    is_enabled: enabled ? 1 : 0,
    is_installed: 1,
    load_order: 1,
    priority: 1,
    tags: '[]',
    conflicts: '[]',
    requires: '[]',
    translation_it: 0,
    nexus_url: null,
    thumbnail_url: null,
    created_at: '',
    updated_at: '',
  }
}

describe('runPreflight', () => {
  it('fails when the game path is missing', () => {
    const checks = runPreflight({ settings: baseSettings, mods: [], totalSizeGB: 0 })
    const gp = checks.find((c) => c.id === 'game-path')!
    expect(gp.status).toBe('fail')
  })

  it('fails when Skyrim is under Program Files', () => {
    const checks = runPreflight({
      settings: { ...baseSettings, gamePath: 'C:\\Program Files (x86)\\Steam\\Skyrim' },
      mods: [],
      totalSizeGB: 0,
    })
    expect(checks.find((c) => c.id === 'program-files')!.status).toBe('fail')
  })

  it('passes the location check outside Program Files', () => {
    const checks = runPreflight({
      settings: { ...baseSettings, gamePath: 'D:\\Games\\Skyrim Special Edition' },
      mods: [],
      totalSizeGB: 0,
    })
    expect(checks.find((c) => c.id === 'program-files')!.status).toBe('ok')
  })

  it('warns when no SKSE framework is active', () => {
    const checks = runPreflight({ settings: baseSettings, mods: [modNamed('SkyUI')], totalSizeGB: 0 })
    expect(checks.find((c) => c.id === 'framework')!.status).toBe('warn')
  })

  it('detects an active SKSE framework', () => {
    const checks = runPreflight({
      settings: baseSettings,
      mods: [modNamed('SKSE64 Script Extender')],
      totalSizeGB: 0,
    })
    expect(checks.find((c) => c.id === 'framework')!.status).toBe('ok')
  })

  it('summary marks not-ready when any check fails', () => {
    const checks = runPreflight({ settings: baseSettings, mods: [], totalSizeGB: 0 })
    expect(preflightSummary(checks).ready).toBe(false)
  })
})
