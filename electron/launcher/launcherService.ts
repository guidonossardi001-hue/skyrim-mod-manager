import { spawn, execFileSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

// Modded-game launcher (Nolvus/Mod Organizer 2 style): spawns the resolved game
// executable DETACHED from Electron's process tree (SKSE/the game keep running
// after the mod manager closes) and creates a desktop .lnk shortcut to the same
// executable so the user can start the modded game without opening the manager
// at all. Electron-free (no `app`/`ipcMain` import) so every function here is
// unit-testable with real temp files, matching the rest of electron/*/*.ts.
//
// Windows .lnk creation has no built-in Node API, and every native binding for it
// (windows-shortcuts, etc.) drags in a prebuilt C++ addon that breaks across
// Electron/Node ABI bumps. WScript.Shell.CreateShortcut, driven by a throwaway
// VBScript run through the OS-bundled wscript.exe, needs zero dependencies —
// the same mechanism Windows installers have used for two decades.

export interface LaunchGameOptions {
  exePath: string
  cwd?: string
  args?: string[]
}

export interface LaunchGameResult {
  success: boolean
  pid?: number
  error?: string
}

/**
 * Spawn the game executable detached from Electron.
 *   • `detached: true`  — Windows puts the child in its own process group
 *     (DETACHED_PROCESS), so it is not tied to Electron's console/job object.
 *   • `stdio: 'ignore'` — closes the inherited stdin/stdout/stderr pipes; an open
 *     pipe to the parent is exactly what keeps a "detached" child tethered.
 *   • `child.unref()`   — lets Electron's event loop exit without waiting on the
 *     child, so quitting the mod manager can never wait on (or kill) the game.
 * No-throw boundary: a spawn failure (missing exe, permissions) returns a Result,
 * it never rejects/throws into the caller.
 */
export function launchGame(opts: LaunchGameOptions): LaunchGameResult {
  // Defense-in-depth (SRB-001): never spawn from a UNC path — it would mount a remote/WebDAV
  // share and run a remote executable. The exe path is resolved from settings (now UNC-guarded),
  // but this boundary must hold regardless of how the caller obtained the path.
  if (/^\\\\/.test(opts.exePath ?? '') || /^\/\//.test(opts.exePath ?? '')) {
    return { success: false, error: `Percorso UNC non consentito: ${opts.exePath}` }
  }
  if (!opts.exePath || !existsSync(opts.exePath)) {
    return { success: false, error: `Eseguibile non trovato: ${opts.exePath}` }
  }
  try {
    const child = spawn(opts.exePath, opts.args ?? [], {
      cwd: opts.cwd ?? dirname(opts.exePath),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    // A synchronous spawn failure (e.g. ENOENT racing the existsSync check above,
    // or EACCES) surfaces as an 'error' event, not a thrown exception — without
    // this listener Node would crash the whole main process on that event.
    child.on('error', () => {
      /* already reported via the synchronous existsSync guard for the common case;
         a listener must still exist so a late async failure cannot crash main. */
    })
    child.unref()
    return { success: true, pid: child.pid }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

export interface CreateShortcutOptions {
  targetExePath: string
  shortcutName: string // desktop filename WITHOUT the .lnk extension
  args?: string
  iconPath?: string | null // falls back to targetExePath's own icon when absent
  workingDir?: string // defaults to dirname(targetExePath)
  desktopDir: string // injected (caller resolves app.getPath('desktop')) — keeps this module Electron-free
}

export interface CreateShortcutResult {
  success: boolean
  shortcutPath?: string
  error?: string
}

/** Reduce a display name to a safe Windows filename (same rule as electron/util/paths.ts). */
function sanitizeShortcutName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Gioco'
  )
}

/** Escape a string for a VBScript double-quoted literal: `"` becomes `""`. */
function vbsQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * Create a Windows .lnk desktop shortcut via a throwaway VBScript run through the
 * OS-bundled wscript.exe (WScript.Shell.CreateShortcut). The script is written to
 * a random temp file, executed once, and deleted — nothing persists but the .lnk.
 */
export function createDesktopShortcut(opts: CreateShortcutOptions): CreateShortcutResult {
  if (!opts.targetExePath || !existsSync(opts.targetExePath)) {
    return { success: false, error: `Eseguibile di destinazione non trovato: ${opts.targetExePath}` }
  }
  const shortcutPath = join(opts.desktopDir, `${sanitizeShortcutName(opts.shortcutName)}.lnk`)
  const workingDir = opts.workingDir ?? dirname(opts.targetExePath)
  // WScript.Shell resolves IconLocation relative to nothing in particular when the
  // path is missing/invalid, so only pass a custom icon when it genuinely exists;
  // otherwise let the shortcut fall back to the target exe's own embedded icon.
  const iconLocation = opts.iconPath && existsSync(opts.iconPath) ? opts.iconPath : opts.targetExePath

  const vbs = [
    'Set oWS = WScript.CreateObject("WScript.Shell")',
    `sLinkFile = ${vbsQuote(shortcutPath)}`,
    'Set oLink = oWS.CreateShortcut(sLinkFile)',
    `oLink.TargetPath = ${vbsQuote(opts.targetExePath)}`,
    `oLink.Arguments = ${vbsQuote(opts.args ?? '')}`,
    `oLink.WorkingDirectory = ${vbsQuote(workingDir)}`,
    `oLink.IconLocation = ${vbsQuote(iconLocation)}`,
    `oLink.Description = ${vbsQuote(opts.shortcutName)}`,
    'oLink.Save',
    '',
  ].join('\r\n')

  const vbsPath = join(tmpdir(), `smm-shortcut-${randomUUID()}.vbs`)
  try {
    writeFileSync(vbsPath, vbs, 'utf8')
    // //nologo suppresses the WSH banner; //B (batch mode) suppresses script error
    // dialogs so a malformed path fails back to us via the exit code instead of
    // popping a modal on the user's desktop.
    // Absolute path: a bare 'wscript.exe' could resolve to a planted binary on PATH/CWD.
    const wscriptExe = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'wscript.exe')
    execFileSync(wscriptExe, ['//nologo', '//B', vbsPath], { windowsHide: true, timeout: 8000 })
    if (!existsSync(shortcutPath)) {
      return { success: false, error: 'wscript.exe non ha generato il collegamento (nessun errore riportato)' }
    }
    return { success: true, shortcutPath }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  } finally {
    try {
      unlinkSync(vbsPath)
    } catch {
      /* best-effort cleanup of the throwaway script */
    }
  }
}

/** First existing path among candidates (priority order), or null if none exist. */
export function resolveLauncherIcon(candidates: (string | null | undefined)[]): string | null {
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}
