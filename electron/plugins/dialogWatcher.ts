import { spawn, type ChildProcess } from 'child_process'
import * as readline from 'readline'
import { resolvePowerShellExe } from '../util/paths'

// Auto-dismiss dei dialog nativi BLOCCANTI di xEdit durante Quick Auto Clean (T20) —
// verificato dal vivo (2026-07-18) che xEdit NON è realmente headless: mostra due dialog
// modali al primo avvio di OGNI processo (avviso versione 64bit, promemoria donazioni
// ElminsterAU) che il flag `-autoexit`/`windowsHide` non sopprime (sono finestre GUI create
// esplicitamente dall'app, non la finestra principale del processo). Nessun flag CLI/ini/
// registro noto li sopprime in modo permanente (ricerca dedicata su source xEdit + tool
// community PACT — vedi electron/plugins/qacRunner.ts per le fonti).
//
// Approccio: un processo PowerShell POLLA le finestre TOP-LEVEL appartenenti allo STESSO
// PID del processo xEdit che abbiamo spawnato (mai altre finestre — nessun rischio di
// toccare finestre di altre app), e quando trova un titolo che corrisponde ESATTAMENTE a
// una delle due firme note, clicca il pulsante corretto inviando BM_CLICK DIRETTAMENTE
// all'HWND del bottone (mai WM_CLOSE, mai SendKeys/foreground globale) — chirurgico, zero
// rischio di inviare input a una finestra sbagliata. Un "Confirm" generico SENZA il testo
// "64bit" tra i figli non viene mai toccato: meglio lasciare un dialog sconosciuto bloccato
// (visibile, diagnosticabile) che cliccare alla cieca su qualcosa che potremmo non conoscere.

/** Firme dei DUE dialog noti, verificate dal vivo. `requiredChildTextContains` è un secondo
 *  controllo di sicurezza per il titolo generico "Confirm": senza un figlio il cui testo
 *  contiene questa stringa, il dialog NON viene toccato. */
export const DIALOG_SIGNATURES = [
  { title: 'Confirm', buttonText: 'Yes', requiredChildTextContains: '64bit' },
  { title: 'A message from the developer', buttonText: 'Close', requiredChildTextContains: null as string | null },
] as const

export type DialogSignature = (typeof DIALOG_SIGNATURES)[number]

/**
 * Costruisce lo script PowerShell (testabile senza spawnare nulla). Poll ogni 300ms fino a
 * `maxDurationMs` o finché il processo target (per PID) non esiste più. `pid` è un intero
 * risolto da noi (mai testo utente): nessun rischio di injection nell'interpolazione.
 */
export function buildWatcherScript(pid: number, maxDurationMs: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid non valido: ${pid}`)
  if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0) throw new Error(`maxDurationMs non valido: ${maxDurationMs}`)

  const signaturesPs = DIALOG_SIGNATURES.map(
    (s) =>
      `[PSCustomObject]@{ Title = ${psQuote(s.title)}; Button = ${psQuote(s.buttonText)}; RequiredText = ${s.requiredChildTextContains ? psQuote(s.requiredChildTextContains) : '$null'} }`,
  ).join(', ')

  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SmmWin32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

function Get-WinText([IntPtr]$hwnd) {
  $sb = New-Object System.Text.StringBuilder 512
  [SmmWin32]::GetWindowText($hwnd, $sb, 512) | Out-Null
  return $sb.ToString()
}

$targetPid = ${pid}
$deadline = (Get-Date).AddMilliseconds(${maxDurationMs})
$BM_CLICK = 0x00F5
$signatures = @(${signaturesPs})
$dismissed = New-Object System.Collections.Generic.HashSet[IntPtr]

while ((Get-Date) -lt $deadline) {
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $proc) { Write-Output "PROCESS_GONE"; break }

  $topWindows = New-Object System.Collections.Generic.List[IntPtr]
  [SmmWin32]::EnumWindows({
    param($hwnd, $lparam)
    $procId = 0
    [SmmWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    if ($procId -eq $targetPid -and [SmmWin32]::IsWindowVisible($hwnd)) { $topWindows.Add($hwnd) }
    return $true
  }, [IntPtr]::Zero) | Out-Null

  foreach ($hwnd in $topWindows) {
    if ($dismissed.Contains($hwnd)) { continue }
    $title = Get-WinText $hwnd
    $sig = $signatures | Where-Object { $_.Title -eq $title } | Select-Object -First 1
    if (-not $sig) { continue }

    $children = New-Object System.Collections.Generic.List[IntPtr]
    [SmmWin32]::EnumChildWindows($hwnd, {
      param($child, $lparam2)
      $children.Add($child)
      return $true
    }, [IntPtr]::Zero) | Out-Null

    if ($sig.RequiredText) {
      $hasRequiredText = $false
      foreach ($c in $children) {
        if ((Get-WinText $c) -like "*$($sig.RequiredText)*") { $hasRequiredText = $true; break }
      }
      if (-not $hasRequiredText) { continue }
    }

    $clicked = $false
    foreach ($c in $children) {
      $childText = (Get-WinText $c) -replace '&', ''
      if ($childText -eq $sig.Button) {
        [SmmWin32]::SendMessage($c, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Write-Output "DISMISSED: $title -> $($sig.Button)"
        $dismissed.Add($hwnd) | Out-Null
        $clicked = $true
        break
      }
    }
    if (-not $clicked) { Write-Output "SIGNATURE_MATCHED_NO_BUTTON: $title" }
  }
  Start-Sleep -Milliseconds 300
}
Write-Output "WATCHER_DONE"
`.trim()
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ── Nucleo puro: classificazione delle righe di output (testabile senza spawn) ──────────────

export type WatcherEvent =
  | { type: 'dismissed'; title: string; button: string }
  | { type: 'signature-no-button'; title: string }
  | { type: 'process-gone' }
  | { type: 'done' }
  | { type: 'unknown'; line: string }

export function parseWatcherLine(line: string): WatcherEvent {
  const trimmed = line.trim()
  if (trimmed === 'PROCESS_GONE') return { type: 'process-gone' }
  if (trimmed === 'WATCHER_DONE') return { type: 'done' }
  const dismissedMatch = trimmed.match(/^DISMISSED:\s*(.+?)\s*->\s*(.+)$/)
  if (dismissedMatch) return { type: 'dismissed', title: dismissedMatch[1], button: dismissedMatch[2] }
  const noButtonMatch = trimmed.match(/^SIGNATURE_MATCHED_NO_BUTTON:\s*(.+)$/)
  if (noButtonMatch) return { type: 'signature-no-button', title: noButtonMatch[1] }
  return { type: 'unknown', line: trimmed }
}

// ── IO: spawn reale del watcher ───────────────────────────────────────────────────────────

export interface DialogWatcherHandle {
  /** Ferma il watcher (chiamare quando il processo xEdit principale termina). Idempotente. */
  stop: () => void
}

export interface StartDialogWatcherOptions {
  /** Durata massima del poll (deve coprire l'intero timeout del run QAC che lo ospita). */
  maxDurationMs: number
  onEvent?: (ev: WatcherEvent) => void
  /** Iniettabile nei test: stessa firma di child_process.spawn. Default: spawn reale. */
  spawnImpl?: typeof spawn
}

/** Avvia il watcher per il PID del processo xEdit appena spawnato. Mai un throw: un
 *  fallimento di spawn del watcher è solo loggato (onEvent 'unknown'), il QAC prosegue
 *  comunque col comportamento preesistente (l'utente potrebbe dover cliccare a mano). */
export function startDialogWatcher(pid: number, opts: StartDialogWatcherOptions): DialogWatcherHandle {
  let child: ChildProcess | null = null
  try {
    const script = buildWatcherScript(pid, opts.maxDurationMs)
    const doSpawn = opts.spawnImpl ?? spawn
    child = doSpawn(resolvePowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => opts.onEvent?.(parseWatcherLine(line)))
    }
    child.on('error', (e) => opts.onEvent?.({ type: 'unknown', line: `spawn watcher fallito: ${e.message}` }))
  } catch (e) {
    opts.onEvent?.({ type: 'unknown', line: `avvio watcher fallito: ${(e as Error).message}` })
  }
  return {
    stop: () => {
      try {
        child?.kill()
      } catch {
        /* già terminato: nulla da fare */
      }
    },
  }
}
