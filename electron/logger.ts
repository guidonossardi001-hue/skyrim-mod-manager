import { app } from 'electron'
import { appendFile, mkdir, stat, rename, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// Lightweight structured logger inspired by Nolvus's Serilog usage: every
// download/install operation is timestamped and appended to a size-rotated file
// under userData/logs, so real-world failures can be diagnosed after the fact.
type Level = 'INFO' | 'WARN' | 'ERROR'

const MAX_LOG_BYTES = 5 * 1024 * 1024 // oltre 5 MB il log ruota su .1 (una generazione)

let logFile: string | null = null
let initializing: Promise<void> | null = null

async function ensureLogFile(): Promise<string> {
  if (logFile) return logFile
  if (!initializing) {
    initializing = (async () => {
      const dir = join(app.getPath('userData'), 'logs')
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      logFile = join(dir, 'dashboard.log')
    })()
  }
  await initializing
  return logFile!
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const s = await stat(file)
    if (s.size < MAX_LOG_BYTES) return
    const old = `${file}.1`
    await rm(old, { force: true })
    await rename(file, old)
  } catch {
    /* file assente o in uso: si scrive comunque */
  }
}

async function write(level: Level, scope: string, message: string) {
  const line = `${new Date().toISOString()} [${level}] (${scope}) ${message}\n`
  if (level === 'ERROR') console.error(line.trimEnd())
  else console.log(line.trimEnd())
  try {
    const file = await ensureLogFile()
    await rotateIfNeeded(file)
    await appendFile(file, line, 'utf8')
  } catch {
    /* never let logging crash the operation it is logging */
  }
}

export const logger = {
  info: (scope: string, message: string) => void write('INFO', scope, message),
  warn: (scope: string, message: string) => void write('WARN', scope, message),
  error: (scope: string, message: string) => void write('ERROR', scope, message),
}
