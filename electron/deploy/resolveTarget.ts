import { join } from 'path'
import { sanitizePathSegment } from '../util/paths'

// Risoluzione della directory Data di deploy — UNICA fonte per main.ts (engine IPC) e
// preflight (verifica integrità pre-lancio): il target 'game' (default) è la Data del
// gioco reale, 'instance' l'istanza dedicata per-profilo. Pura: input primitivi.

export interface DeployTargetInputs {
  /** Setting `deployTarget`; undefined = default 'game' (stessa semantica di main.ts). */
  deployTarget: string | undefined
  /** `<gamePath>/Data`; null se il gioco non è risolvibile. */
  gameDataDir: string | null
  /** Nome del profilo attivo (per il target 'instance'); null = profilo non trovato. */
  profileName: string | null
  /** Radice istanze (setting `instancePath` o `<userData>/instances`). */
  instanceRoot: string
}

export function resolveDeployDataDir(i: DeployTargetInputs): string | null {
  if ((i.deployTarget ?? 'game') === 'game') return i.gameDataDir
  if (!i.profileName) return null
  return join(i.instanceRoot, sanitizePathSegment(i.profileName, 'profile'), 'Data')
}
