import type { IniTemplate, IniFileMap } from './iniService'

// Built-in profile INI templates + the mod-required override set. These feed
// applyIniSettings: the chosen template supplies Levels 1–2 (base defaults + quality
// tuning) and MOD_REQUIRED_OVERRIDES supplies Level 3 (forced keys every modded
// setup needs, injected into their exact sections without touching anything else).

// ── Level 1: clean base defaults (seeded only into a brand-new instance file) ──────
const BASE: IniFileMap = {
  'Skyrim.ini': {
    General: { sLanguage: 'ENGLISH', uGridsToLoad: 5, 'uExterior Cell Buffer': 36 },
    Display: { fSunShadowUpdateTime: 0.25, fSunUpdateThreshold: 1.5 },
    Archive: { bInvalidateOlderFiles: 1, sResourceDataDirsFinal: '' },
  },
  'SkyrimPrefs.ini': {
    Display: { 'iSize W': 1920, 'iSize H': 1080, iShadowMapResolution: 2048, bTreesReceiveShadows: 1 },
    Launcher: { bEnableFileSelection: 1 },
  },
}

// ── Level 2: quality presets (overlay the base) ───────────────────────────────────
const ULTRA: IniFileMap = {
  'SkyrimPrefs.ini': {
    Display: {
      iShadowMapResolution: 4096, // crisp shadows
      fShadowDistance: 8000, // distant shadow casting
      iMaxAnisotropy: 16,
      fLODFadeOutMultObjects: 15, // distant objects draw farther
      fLODFadeOutMultItems: 5,
    },
  },
}

const PERFORMANCE: IniFileMap = {
  'SkyrimPrefs.ini': {
    Display: {
      iShadowMapResolution: 1024, // cheaper shadows
      fShadowDistance: 2500,
      iMaxAnisotropy: 4,
      fLODFadeOutMultObjects: 6,
      fLODFadeOutMultItems: 2,
    },
  },
  'Skyrim.ini': {
    General: { uGridsToLoad: 5 },
  },
}

const VR: IniFileMap = {
  'SkyrimPrefs.ini': {
    Display: {
      iShadowMapResolution: 2048,
      bMainZoomEnabled: 0, // VR disables the 2D zoom path
    },
    VRUI: { fUIProjectionZoomFactor: 1.0 },
  },
}

const template = (name: string, settings: IniFileMap): IniTemplate => ({ name, base: BASE, settings })

export const INI_TEMPLATES: Record<string, IniTemplate> = {
  base: template('Base', {}),
  ultra: template('Ultra Graphics', ULTRA),
  performance: template('Performance', PERFORMANCE),
  vr: template('VR', VR),
}

/**
 * Level 3 — keys some mods REQUIRE to function, forced regardless of template or user
 * config. Injected into their exact sections (e.g. loose-file loading in [Archive],
 * intro-logo skip in [General]) so a fresh modded profile boots correctly.
 */
export const MOD_REQUIRED_OVERRIDES: IniFileMap = {
  'Skyrim.ini': {
    General: {
      bAllowScreenshot: 1,
      bEnableFileSelection: 1,
    },
    Archive: {
      bInvalidateOlderFiles: 1, // load loose files that override BSAs (most texture mods)
      sResourceDataDirsFinal: '',
    },
  },
  'SkyrimPrefs.ini': {
    General: {
      bPreloadIntroLogos: 0, // skip Bethesda/mod intro logos (SkyUI/EngineFixes expectation)
    },
    Launcher: {
      bEnableFileSelection: 1,
    },
  },
}

/** Resolve a template by name (case-insensitive), falling back to the clean base. */
export function resolveIniTemplate(name?: string): IniTemplate {
  if (!name) return INI_TEMPLATES.base
  return INI_TEMPLATES[name.toLowerCase()] ?? INI_TEMPLATES.base
}
