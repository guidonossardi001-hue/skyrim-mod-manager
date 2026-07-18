// Report diagnostico esportabile (gap Nolvus: ReportService.GenerateReportToClipBoard) — un
// blob di testo copiabile pronto per un bug report/richiesta di supporto (Discord/GitHub),
// invece di dover chiedere all'utente di descrivere hardware/stato a mano. Sola lettura, mai
// una scrittura: aggrega dati già raccolti altrove (nessuna nuova sonda qui dentro).
//
// PURA: la formattazione vive qui (testabile senza Electron/DB); la RACCOLTA dei dati (main.ts,
// IPC diagnostics:generate-report) resta fuori, come ogni altro assemblaggio di LaunchEnv-like.

export interface DiagnosticsData {
  generatedAt: string
  appVersion: string
  platform: string
  osRelease: string
  cpuModel: string | null
  cpuCores: number
  ramGB: number | null
  gpuName: string | null
  gpuVramGB: number | null
  steamInstalled: boolean
  gamePath: string | null
  gameVersion: string | null
  sksePresent: boolean
  skseVersion: string | null
  activeProfileName: string | null
  modsTotal: number
  modsEnabled: number
  modsInstalled: number
  deployChecked: boolean
  deployMissing: number
  deployReplaced: number
  deployJunctionsMissing: number
  /** Path dell'ultimo crash log notificato (electron/notify.ts), se presente. */
  lastCrashLog: string | null
}

export function formatDiagnosticsReport(d: DiagnosticsData): string {
  const lines: string[] = []
  lines.push(`Skyrim AE Mod Manager — Report diagnostico (${d.generatedAt})`)
  lines.push('')
  lines.push(`App: v${d.appVersion}`)
  lines.push(`OS: ${d.platform} ${d.osRelease}`)
  lines.push(`CPU: ${d.cpuModel ?? 'sconosciuta'} (${d.cpuCores} core)`)
  lines.push(`RAM: ${d.ramGB != null ? `${d.ramGB} GB` : 'sconosciuta'}`)
  lines.push(`GPU: ${d.gpuName ?? 'sconosciuta'}${d.gpuVramGB != null ? ` — ${d.gpuVramGB} GB VRAM` : ''}`)
  lines.push('')
  lines.push(`Steam: ${d.steamInstalled ? 'rilevato' : 'NON rilevato'}`)
  lines.push(`Skyrim: ${d.gamePath ?? 'NON rilevato'}${d.gameVersion ? ` (v${d.gameVersion})` : ''}`)
  lines.push(`SKSE: ${d.sksePresent ? `presente${d.skseVersion ? ` v${d.skseVersion}` : ''}` : 'ASSENTE'}`)
  lines.push('')
  lines.push(`Profilo attivo: ${d.activeProfileName ?? 'sconosciuto'}`)
  lines.push(`Mod: ${d.modsEnabled}/${d.modsTotal} abilitate, ${d.modsInstalled} installate`)
  lines.push('')
  lines.push(
    d.deployChecked
      ? `Deploy: verificato — ${d.deployMissing} mancanti, ${d.deployReplaced} sostituiti esternamente, ${d.deployJunctionsMissing} junction scollegate`
      : 'Deploy: nessun manifest verificabile (mai deployato, o già purgato)',
  )
  if (d.lastCrashLog) lines.push(`Ultimo crash notificato: ${d.lastCrashLog}`)
  return lines.join('\n')
}
