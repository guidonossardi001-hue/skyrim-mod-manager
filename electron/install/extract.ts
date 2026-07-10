import { createReadStream, existsSync, mkdirSync, statSync, rmSync, renameSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { resolve, relative, isAbsolute, extname, join } from 'path'

// Safe, streaming archive handling for real (multi-GB) mod archives.
//   • sha256 is computed by STREAMING the file (never buffering GBs in memory),
//   • extraction prefers the system 7-Zip — it streams, handles every format and
//     huge files, and we PARSE its progress (-bsp1) while draining stdout/stderr so
//     the child can never deadlock on a full pipe buffer,
//   • the bundled .zip fallback (adm-zip) is memory-bound, so it is gated behind a
//     size cap and a per-entry zip-slip guard (path traversal defense-in-depth).
// Electron-free so the guards/parsers are unit-testable.

export function toLongPath(p: string): string {
  return process.platform === 'win32' && !p.startsWith('\\\\?\\') ? '\\\\?\\' + resolve(p) : p
}

/** Recursive listing of `root`, returning POSIX paths relative to it (files only). */
export function listFilesRel(root: string): string[] {
  const out: string[] = []
  const walk = (absDir: string, relDir: string) => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(toLongPath(absDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(absDir, e.name)
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out
}

/** Streaming sha256 — constant memory regardless of archive size. */
export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('error', rej)
    s.on('data', (d) => h.update(d as Buffer))
    s.on('end', () => res(h.digest('hex')))
  })
}

export async function verifyArchiveHash(
  path: string,
  expected: string,
): Promise<{ ok: boolean; actual: string }> {
  const actual = await sha256File(path)
  return { ok: actual.toLowerCase() === expected.toLowerCase(), actual }
}

/** True iff `child` resolves to a path at or under `parent` (zip-slip guard). */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Throws if any archive entry would resolve outside destDir (zip-slip / path traversal). */
export function assertNoZipSlip(entryNames: string[], destDir: string): void {
  const root = resolve(destDir)
  for (const name of entryNames) {
    if (!isPathInside(root, resolve(destDir, name))) {
      throw new Error(`Voce archivio non sicura (zip-slip): ${name}`)
    }
  }
}

/** Extract the latest NN% emitted by `7z … -bsp1` (it prints many per line). */
export function parse7zProgress(text: string): number | null {
  const m = [...text.matchAll(/(\d{1,3})%/g)]
  if (!m.length) return null
  const pct = Number(m[m.length - 1][1])
  return pct >= 0 && pct <= 100 ? pct : null
}

export interface ExtractOptions {
  full7zPath?: string // full 7-Zip (system via detect7zPath, or bundled) — for .rar
  bundled7zaPath?: string // bundled standalone 7za (no .rar) — default engine for .7z/.zip
  onProgress?: (percent: number) => void
  admZipMaxBytes?: number // OOM guard for the in-memory zip fallback (default 256 MB)
  signal?: AbortSignal // abort: kills the 7-Zip child / stops the zip loop
  includeFilters?: string[] // recipe optimization: 7z -ir! patterns (POSIX); extract only these subtrees
}

function run7z(
  sevenZip: string,
  archivePath: string,
  destDir: string,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
  includeFilters?: string[],
): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Error('annullato'))
    // Recipe optimization: for each include pattern, both the entry itself and its
    // subtree (`\*`) so a prefix like "00 Core" pulls its whole tree but the unwanted
    // 4K/8K variant folders are never unpacked. Over-inclusion is harmless — planRecipe
    // still filters — so this can only ever be a superset of what we keep.
    const filterArgs = (includeFilters ?? []).flatMap((p) => {
      const win = p.replace(/\//g, '\\')
      return [`-ir!${win}`, `-ir!${win}\\*`]
    })
    // x=extract w/ paths, -y=assume yes, -bsp1=progress to stdout, -aoa=overwrite all.
    const proc = spawn(
      sevenZip,
      ['x', archivePath, `-o${destDir}`, '-y', '-bsp1', '-aoa', ...filterArgs],
      { windowsHide: true },
    )
    let stderr = ''
    // Abort: kill the child process tree so a multi-GB extraction stops promptly.
    const onAbort = () => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      rej(new Error('annullato'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout.on('data', (d: Buffer) => {
      const p = parse7zProgress(d.toString())
      if (p != null) onProgress?.(p)
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    }) // drain to avoid deadlock
    proc.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      rej(e)
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return // onAbort already rejected
      code === 0
        ? res()
        : rej(
            new Error(
              `7-Zip terminato con codice ${code}${stderr ? ': ' + stderr.trim().slice(0, 200) : ''}`,
            ),
          )
    })
  })
}

async function extractZipSafely(
  archivePath: string,
  destDir: string,
  maxBytes: number,
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const size = statSync(archivePath).size
  if (size > maxBytes) {
    throw new Error(
      `Archivio .zip troppo grande (${size} byte) per l'estrattore integrato: configura 7-Zip nelle Impostazioni`,
    )
  }
  const AdmZip = (await import('adm-zip')).default
  const zip = new AdmZip(archivePath)
  const entries = zip.getEntries()
  // Zip-slip guard: refuse if ANY entry would land outside destDir before extracting.
  assertNoZipSlip(
    entries.map((e) => e.entryName),
    destDir,
  )
  // adm-zip is the small-file fallback and does not handle Windows \\?\ paths, so use
  // the plain destDir here (deep trees are 7-Zip's job, which does support long paths).
  let done = 0
  for (const e of entries) {
    if (signal?.aborted) throw new Error('annullato') // best-effort abort BETWEEN entries (synchronous lib)
    zip.extractEntryTo(e, destDir, /* maintainEntryPath */ true, /* overwrite */ true)
    onProgress?.(Math.round((++done / entries.length) * 100))
  }
}

/**
 * Extract `archivePath` into `destDir`, streaming via 7-Zip (a child process, so the
 * UI/renderer thread is never touched) with live progress.
 *   • .rar       → requires the FULL system 7-Zip (Rar codec); the bundled 7za can't.
 *   • .7z/.zip/… → the bundled 7za handles them with NO configuration; a configured
 *                  system 7-Zip, if present, takes precedence.
 *   • .zip with no 7-Zip at all → in-memory adm-zip fallback (size-capped, zip-slip-guarded).
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  opts: ExtractOptions = {},
): Promise<{ method: '7z' | '7za' | 'zip' }> {
  // ATOMIC extraction: unpack into a sibling `<destDir>.tmp` and, only on full
  // success, atomically rename it into place. A crash/abort/partial extract then
  // leaves ONLY the .tmp behind — never a half-written destDir that a resumed run
  // would mistake for a completed mod. Any stale .tmp from a previous crash is
  // discarded first, and the .tmp is cleaned up if extraction fails.
  const ext = extname(archivePath).toLowerCase()
  const full7z = opts.full7zPath && existsSync(opts.full7zPath) ? opts.full7zPath : null
  const bundled = opts.bundled7zaPath && existsSync(opts.bundled7zaPath) ? opts.bundled7zaPath : null

  const tmpDir = destDir + '.tmp'
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  // tmpDir (mods/<modname>.tmp) is shallow; create it plainly. The DEEP internal tree is
  // created by the extractor itself (7-Zip handles \\?\ via its -o argument).
  mkdirSync(tmpDir, { recursive: true })

  const cleanupTmp = () => {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  let method: '7z' | '7za' | 'zip'
  try {
    if (ext === '.rar') {
      // .rar needs the FULL 7-Zip (Rar codec): system install (primary) or the bundled
      // full 7z (fallback) — both resolved by the caller via resolveRar7z.
      if (!full7z) {
        throw new Error(
          'Estrazione .rar non disponibile: nessun 7-Zip completo trovato. Installa 7-Zip da 7-zip.org (verrà rilevato automaticamente).',
        )
      }
      await run7z(full7z, archivePath, toLongPath(tmpDir), opts.onProgress, opts.signal, opts.includeFilters)
      method = '7z'
    } else {
      // .7z/.zip/…: the bundled standalone 7za is the default (cross-platform, no config);
      // a full 7-Zip works too and serves as a fallback.
      const engine = bundled ?? full7z
      if (engine) {
        await run7z(engine, archivePath, toLongPath(tmpDir), opts.onProgress, opts.signal, opts.includeFilters)
        method = engine === bundled ? '7za' : '7z'
      } else if (ext === '.zip') {
        await extractZipSafely(
          archivePath,
          tmpDir,
          opts.admZipMaxBytes ?? 256 * 1024 * 1024,
          opts.onProgress,
          opts.signal,
        )
        method = 'zip'
      } else {
        throw new Error(`Nessun estrattore 7-Zip disponibile per ${ext || '(sconosciuto)'}`)
      }
    }
  } catch (e) {
    cleanupTmp()
    throw e
  }

  // Commit: replace any prior/partial destDir, then atomic same-volume rename.
  try {
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
    renameSync(tmpDir, destDir)
  } catch (e) {
    cleanupTmp()
    throw e
  }
  return { method }
}
