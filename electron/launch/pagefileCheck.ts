import { execFileSync } from 'child_process'
import { join } from 'path'

// Preflight pagefile (gap Nolvus): il loro installer avvisa esplicitamente che la dimensione
// del pagefile è "REALLY IMPORTANT to avoid crashes" prima dell'install — un pagefile fisso
// troppo piccolo è una causa nota di crash Skyrim/SKSE sotto modding pesante (già presente
// come consiglio REATTIVO in crashPatterns.ts dopo un crash; qui diventa un check PROATTIVO
// prima del lancio). Sola lettura, mai un blocco — solo un avviso, come deployIntegrity/8b.

const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const POWERSHELL_EXE = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export interface PagefileInfo {
  /** null = non rilevabile (probe fallito/PowerShell assente/output inatteso). */
  autoManaged: boolean | null
  /** Somma AllocatedBaseSize (MB) di tutti i pagefile fissi; null = non rilevabile. */
  totalMB: number | null
}

/** Interroga Win32_ComputerSystem/Win32_PageFileUsage via PowerShell/CIM. Sola lettura, mai
 *  throw: un probe fallito torna dati null, mai un errore che si propaga al preflight. */
export function queryPagefileInfo(exec: typeof execFileSync = execFileSync): PagefileInfo {
  try {
    const out = exec(
      POWERSHELL_EXE,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 AutomaticManagedPagefile; ' +
          '$pf = Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize -Sum; ' +
          '[PSCustomObject]@{ AutoManaged = $cs.AutomaticManagedPagefile; TotalMB = $pf.Sum } | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    ) as unknown as string
    const parsed = JSON.parse(String(out).trim()) as { AutoManaged?: unknown; TotalMB?: unknown }
    return {
      autoManaged: typeof parsed.AutoManaged === 'boolean' ? parsed.AutoManaged : null,
      totalMB: typeof parsed.TotalMB === 'number' && parsed.TotalMB >= 0 ? parsed.TotalMB : null,
    }
  } catch {
    return { autoManaged: null, totalMB: null }
  }
}

// ── Nucleo puro (testabile senza child_process) ─────────────────────────────────────────────

/** Soglia minima per un pagefile FISSO (non gestito da Windows) — stessa cifra già consigliata
 *  reattivamente in crashPatterns.ts ("pagefile gestito da Windows o 20+ GB fisso"). */
export const MIN_FIXED_PAGEFILE_MB = 20 * 1024

export interface PagefileAdvisory {
  checked: boolean
  concerning: boolean
  detail: string
}

/** Gestito automaticamente da Windows → sempre ok (Windows lo ridimensiona da sé). Fisso →
 *  ok solo sopra la soglia. Dato insufficiente (probe fallito o solo parzialmente riuscito)
 *  → checked:false, mai un avviso spurio su un dato che non abbiamo davvero. */
export function evaluatePagefile(info: PagefileInfo): PagefileAdvisory {
  if (info.autoManaged === true) return { checked: true, concerning: false, detail: 'Gestito automaticamente da Windows' }
  if (info.autoManaged === false && info.totalMB != null) {
    const gb = info.totalMB / 1024
    return info.totalMB >= MIN_FIXED_PAGEFILE_MB
      ? { checked: true, concerning: false, detail: `Pagefile fisso: ${gb.toFixed(1)} GB` }
      : {
          checked: true,
          concerning: true,
          detail: `Pagefile fisso di soli ${gb.toFixed(1)} GB (consigliati 20+ GB, o lascialo gestito da Windows)`,
        }
  }
  return { checked: false, concerning: false, detail: '' }
}
