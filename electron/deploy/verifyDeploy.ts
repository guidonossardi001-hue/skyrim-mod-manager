import { join } from 'path'
import { DEPLOY_MANIFEST_FILE, parseDeployManifest, type DeployManifest } from './plan'

// Rilevamento external-changes sul deploy (PIVOT-02 / T17): col target 'game' i file
// linkati vivono nella Data REALE del gioco, dove tool esterni (xEdit, DynDOLOD, Steam
// "verifica integrità", l'utente stesso) possono cancellarli o sostituirli. Il manifest
// è la verità di cosa il deployer ha creato: qui lo si confronta col disco.
//
//   • file assente          → rimosso da qualcosa di esterno
//   • file con nlink === 1  → NON è più il nostro hardlink: sostituito da una copia esterna
//   • junction assente      → directory scollegata
//
// PURO: IO iniettato (VerifyIo), nessun side effect — solo lettura. Mai throw.

export interface VerifyIo {
  exists: (p: string) => boolean
  /** lstat, mai seguire il link: nlink per i file; per le junction serve isSymbolicLink —
   *  su Windows una junction è un reparse point e lstat dà isDirectory() FALSE anche
   *  quando è perfettamente sana (bug reale: 5323 junction "scollegate" a ogni avvio,
   *  con rideploy completo inutile della riparazione automatica ogni volta). */
  lstat: (p: string) => { nlink: number; isFile: boolean; isDirectory: boolean; isSymbolicLink?: boolean } | null
  readFile: (p: string) => string
}

export interface DeployVerifyResult {
  /** false = nessun manifest leggibile (mai deployato o già purgato): niente da verificare. */
  checked: boolean
  totalFiles: number
  intactFiles: number
  /** Campioni (max 8 ciascuno) + conteggi PIENI: l'UI mostra i primi, i numeri dicono il resto. */
  missing: string[]
  replaced: string[]
  junctionsMissing: string[]
  missingCount: number
  replacedCount: number
  junctionsMissingCount: number
}

const SAMPLE_CAP = 8

const EMPTY: DeployVerifyResult = {
  checked: false,
  totalFiles: 0,
  intactFiles: 0,
  missing: [],
  replaced: [],
  junctionsMissing: [],
  missingCount: 0,
  replacedCount: 0,
  junctionsMissingCount: 0,
}

/** true quando la verifica ha trovato almeno una deviazione dal manifest. */
export function hasDeployDrift(r: DeployVerifyResult): boolean {
  return r.checked && (r.missingCount > 0 || r.replacedCount > 0 || r.junctionsMissingCount > 0)
}

export function verifyDeployedInstance(instanceDataDir: string, io: VerifyIo): DeployVerifyResult {
  let manifest: DeployManifest | null = null
  try {
    const p = join(instanceDataDir, DEPLOY_MANIFEST_FILE)
    if (io.exists(p)) manifest = parseDeployManifest(io.readFile(p))
  } catch {
    manifest = null
  }
  if (!manifest) return EMPTY

  const missing: string[] = []
  const replaced: string[] = []
  const junctionsMissing: string[] = []
  let missingCount = 0
  let replacedCount = 0
  let junctionsMissingCount = 0
  let intactFiles = 0

  for (const rel of manifest.files) {
    const abs = join(instanceDataDir, rel)
    let st: ReturnType<VerifyIo['lstat']> = null
    try {
      st = io.exists(abs) ? io.lstat(abs) : null
    } catch {
      st = null
    }
    if (!st || !st.isFile) {
      missingCount++
      if (missing.length < SAMPLE_CAP) missing.push(rel)
    } else if (st.nlink === 1) {
      // Un nostro hardlink ha SEMPRE nlink ≥ 2 (l'altro nome vive sotto modsRoot):
      // nlink 1 = il file è stato sostituito da una copia indipendente esterna.
      replacedCount++
      if (replaced.length < SAMPLE_CAP) replaced.push(rel)
    } else {
      intactFiles++
    }
  }

  for (const rel of manifest.junctions) {
    const abs = join(instanceDataDir, rel)
    let ok = false
    try {
      // Junction sana = reparse point (lstat: isSymbolicLink true, isDirectory FALSE).
      // isDirectory resta accettato per compatibilità con io legacy senza isSymbolicLink.
      const st = io.exists(abs) ? io.lstat(abs) : null
      ok = !!st && (st.isSymbolicLink === true || st.isDirectory)
    } catch {
      ok = false
    }
    if (!ok) {
      junctionsMissingCount++
      if (junctionsMissing.length < SAMPLE_CAP) junctionsMissing.push(rel)
    }
  }

  return {
    checked: true,
    totalFiles: manifest.files.length,
    intactFiles,
    missing,
    replaced,
    junctionsMissing,
    missingCount,
    replacedCount,
    junctionsMissingCount,
  }
}
