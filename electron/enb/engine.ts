import { ipcMain } from 'electron'
import { scanEnbPresets, applyEnbPreset, removeEnbPreset, type EnbPreset } from './enbManager'

// Thin ipcMain wrapper (stesso pattern degli altri *engine.ts). Path resolution iniettata
// da main.ts: modsRoot (estrazioni) e gameRoot (root del gioco, NON Data).

export interface EnbEngineOptions {
  resolveModsRoot: () => string
  resolveGameRoot: () => string | null
  log?: (level: 'info' | 'warn', msg: string) => void
}

export function initEnbEngine(opts: EnbEngineOptions) {
  ipcMain.handle('enb:scan', (): { ok: boolean; presets: EnbPreset[] } => {
    try {
      const presets = scanEnbPresets(opts.resolveModsRoot())
      opts.log?.('info', `scan ENB: ${presets.length} preset trovati nelle mod estratte`)
      return { ok: true, presets }
    } catch (e) {
      opts.log?.('warn', `scan ENB fallito: ${(e as Error).message}`)
      return { ok: false, presets: [] }
    }
  })

  ipcMain.handle('enb:apply', (_e, presetDir: string, label: string) => {
    const gameRoot = opts.resolveGameRoot()
    if (!gameRoot) return { ok: false as const, error: 'Cartella del gioco non risolvibile' }
    // Il presetDir arriva dalla lista di enb:scan (mai un input libero): lo si ri-valida
    // comunque contro il modsRoot per rifiutare path arbitrari dal renderer.
    const root = opts.resolveModsRoot().replace(/\\/g, '/').toLowerCase()
    if (!presetDir.replace(/\\/g, '/').toLowerCase().startsWith(root))
      return { ok: false as const, error: 'Percorso preset non valido (fuori dalla cartella mod)' }
    const res = applyEnbPreset(presetDir, gameRoot, label)
    if (res.ok)
      opts.log?.(
        'info',
        `preset ENB "${label}" applicato: ${res.applied} file nella root del gioco (${res.backedUp} originali salvati)${res.coreDllPresent ? '' : ' — CORE ENB ASSENTE (d3d11.dll): scaricalo da enbdev.com'}`,
      )
    else opts.log?.('warn', `apply ENB fallito: ${res.error}`)
    return res
  })

  ipcMain.handle('enb:remove', () => {
    const gameRoot = opts.resolveGameRoot()
    if (!gameRoot) return { ok: false as const, removed: 0, restored: 0, error: 'Cartella del gioco non risolvibile' }
    const res = removeEnbPreset(gameRoot)
    opts.log?.('info', `preset ENB rimosso: ${res.removed} file, ${res.restored} originali ripristinati`)
    return res
  })
}
