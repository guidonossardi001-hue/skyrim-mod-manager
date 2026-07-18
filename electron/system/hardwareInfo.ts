import { execFileSync } from 'child_process'
import { cpus, totalmem } from 'os'
import { join } from 'path'
import type { BethiniTier } from '../ini/bethiniPresets'

// Advisory hardware check (gap Nolvus): niente qui BLOCCA mai un preset — è puramente
// informativo, come il "requisiti min/raccomandati" di un installer curato. Sola lettura,
// mai un errore che si propaga: un probe GPU/RAM fallito non deve impedire di applicare
// un preset INI, solo lasciare il consiglio assente (null).

// Absolute System32 path: invocare powershell.exe per nome bare lascerebbe eseguire un
// eseguibile piantato sul PATH/cwd al posto di quello reale di Windows (binary-planting) —
// stessa mitigazione di electron/steam/detect.ts (REG_EXE/TASKLIST_EXE).
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const POWERSHELL_EXE = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export interface HardwareInfo {
  cpuModel: string | null
  cpuCores: number
  ramGB: number | null
  gpuName: string | null
  /** null = non rilevabile O valore implausibile (vedi nota AdapterRAM sotto). */
  gpuVramGB: number | null
}

interface GpuProbeResult {
  name: string | null
  vramBytes: number | null
}

/** Interroga Win32_VideoController via PowerShell/CIM (nessuna rete, nessuna scrittura).
 *  Win32_VideoController.AdapterRAM è un campo a 32 bit SIGNED: molte GPU moderne con >4GB
 *  di VRAM lo riportano azzerato o negativo (overflow/wrap noto di Windows/WMI, non un bug
 *  nostro) — un valore <=0 è quindi trattato come "non attendibile", mai mostrato come dato. */
function queryGpuViaPowerShell(exec: typeof execFileSync = execFileSync): GpuProbeResult {
  try {
    const out = exec(
      POWERSHELL_EXE,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    ) as unknown as string
    const parsed = JSON.parse(String(out).trim()) as { Name?: unknown; AdapterRAM?: unknown }
    const vramBytes = typeof parsed.AdapterRAM === 'number' && parsed.AdapterRAM > 0 ? parsed.AdapterRAM : null
    return { name: typeof parsed.Name === 'string' ? parsed.Name : null, vramBytes }
  } catch {
    return { name: null, vramBytes: null }
  }
}

const bytesToGB = (b: number): number => Math.round((b / 1024 ** 3) * 10) / 10

/** Probe reale: os.* (sempre disponibile, nessun processo) + GPU via PowerShell (best-effort). */
export function detectHardwareInfo(exec: typeof execFileSync = execFileSync): HardwareInfo {
  const gpu = queryGpuViaPowerShell(exec)
  const mem = totalmem()
  return {
    cpuModel: cpus()[0]?.model?.trim() || null,
    cpuCores: cpus().length,
    ramGB: mem > 0 ? bytesToGB(mem) : null,
    gpuName: gpu.name,
    gpuVramGB: gpu.vramBytes != null ? bytesToGB(gpu.vramBytes) : null,
  }
}

// ── Nucleo puro (testabile senza child_process) ─────────────────────────────────────────────

/** Requisiti curati (VRAM/RAM minimi) per tier — stessa filosofia delle tabelle min/raccomandati
 *  di un installer curato: soglie ragionevoli, non un benchmark scientifico. 'poor' = nessun
 *  requisito (tier più basso, sempre raggiungibile). */
export const TIER_ORDER: BethiniTier[] = ['poor', 'low', 'medium', 'high', 'ultra']

interface TierRequirement {
  tier: BethiniTier
  minVramGB: number
  minRamGB: number
}

const TIER_REQUIREMENTS: TierRequirement[] = [
  { tier: 'poor', minVramGB: 0, minRamGB: 0 },
  { tier: 'low', minVramGB: 2, minRamGB: 8 },
  { tier: 'medium', minVramGB: 4, minRamGB: 8 },
  { tier: 'high', minVramGB: 6, minRamGB: 16 },
  { tier: 'ultra', minVramGB: 8, minRamGB: 16 },
]

/** Tier più alto che l'hardware rilevato soddisfa. null = nessun dato utile (né VRAM né RAM
 *  rilevati): mai un consiglio inventato su probe totalmente fallito. Un solo dato mancante
 *  (es. GPU non rilevata ma RAM sì) non blocca il consiglio sull'altro asse. */
export function suggestedMaxTier(hw: { gpuVramGB: number | null; ramGB: number | null }): BethiniTier | null {
  if (hw.gpuVramGB == null && hw.ramGB == null) return null
  let best: BethiniTier = 'poor'
  for (const req of TIER_REQUIREMENTS) {
    const vramOk = hw.gpuVramGB == null || hw.gpuVramGB >= req.minVramGB
    const ramOk = hw.ramGB == null || hw.ramGB >= req.minRamGB
    if (vramOk && ramOk) best = req.tier
  }
  return best
}

/** true se `chosen` è sopra il tier consigliato dall'hardware rilevato — SEMPRE false se non
 *  c'è un consiglio (probe fallito): un avviso spurio è peggio di nessun avviso. */
export function tierExceedsHardware(
  chosen: BethiniTier,
  hw: { gpuVramGB: number | null; ramGB: number | null },
): boolean {
  const max = suggestedMaxTier(hw)
  if (!max) return false
  return TIER_ORDER.indexOf(chosen) > TIER_ORDER.indexOf(max)
}
