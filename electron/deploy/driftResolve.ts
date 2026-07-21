import { join, dirname } from 'path'
import { isPathInside } from '../install/extract'

// Risoluzione interattiva del drift esterno (external-changes): verifyDeployedInstance
// (verifyDeploy.ts) rileva SOLO — qui l'utente sceglie come chiudere ogni voce segnalata:
//   • 'restore' → ricollega il nostro file gestito, ricalcolato dal PLAN CORRENTE (non una
//     copia storica potenzialmente superata: stessa logica di conflictWinner del deploy reale,
//     vedi resolveWinningSourceForRel in deployer.ts) — sovrascrive il file esterno.
//   • 'accept'  → riconosce il file/dir esterno come intenzionale e lo esclude dalle verifiche
//     successive (sidecar accanto al manifest, stesso principio di TOOL_MANAGED_RELS ma
//     per-istanza/utente invece che imposto dal codice).
// Le junction (drift di un'intera directory linkata) supportano solo 'accept' qui: ricrearle
// richiede la stessa pianificazione one-shot del deploy completo (quale mod possiede l'INTERO
// sottoalbero), non una singola risoluzione file — si rimanda a un Deploy completo.

export const ACCEPTED_OVERRIDES_FILE = '.smm-deploy-accepted.json'

export interface DriftResolveIo {
  exists: (p: string) => boolean
  readFile: (p: string) => string
  writeFileAtomic: (p: string, data: string) => void
  unlink: (p: string) => void
  mkdir: (p: string) => void
  link: (src: string, dest: string) => void
}

export type DriftKind = 'file' | 'junction'
export type DriftAction = 'restore' | 'accept'

export interface ResolveDriftResult {
  ok: boolean
  action: DriftAction
  rel: string
  error?: string
}

/** Elenco dei rel accettati come drift esterno intenzionale per questa istanza. */
export function loadAcceptedOverrides(
  instanceDataDir: string,
  io: Pick<DriftResolveIo, 'exists' | 'readFile'>,
): Set<string> {
  try {
    const p = join(instanceDataDir, ACCEPTED_OVERRIDES_FILE)
    if (!io.exists(p)) return new Set()
    const arr = JSON.parse(io.readFile(p)) as unknown
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Risolve UN elemento in drift. `winningSource` (richiesto solo per kind:'file' + action:'restore')
 *  va risolto dal chiamante via resolveWinningSourceForRel (accesso DB, fuori da questo modulo puro). */
export function resolveDriftedFile(
  instanceDataDir: string,
  rel: string,
  kind: DriftKind,
  action: DriftAction,
  winningSource: { src: string } | null,
  io: DriftResolveIo,
): ResolveDriftResult {
  // `rel` arriva grezzo dal renderer via IPC (deploy:resolve-drift): senza containment un
  // '..' sufficiente fa uscire `join(instanceDataDir, rel)` dalla dir dell'istanza, dando
  // unlink/link arbitrari (CWE-22). Stesso guard di isPathInside usato altrove (extract.ts,
  // openTargets.ts, fomodApply.ts).
  if (!isPathInside(instanceDataDir, join(instanceDataDir, rel))) {
    return { ok: false, action, rel, error: 'Percorso non valido (fuori dalla cartella istanza)' }
  }
  if (action === 'accept') {
    try {
      const p = join(instanceDataDir, ACCEPTED_OVERRIDES_FILE)
      const current = loadAcceptedOverrides(instanceDataDir, io)
      current.add(rel)
      io.writeFileAtomic(p, JSON.stringify([...current].sort(), null, 2))
      return { ok: true, action, rel }
    } catch (e) {
      return { ok: false, action, rel, error: (e as Error).message }
    }
  }
  // action === 'restore'
  if (kind === 'junction') {
    return {
      ok: false,
      action,
      rel,
      error: 'Ripristino junction non supportato qui: esegui un Deploy completo dalla Dashboard',
    }
  }
  if (!winningSource) {
    return {
      ok: false,
      action,
      rel,
      error: 'Nessuna mod abilitata fornisce più questo file (rimossa o disabilitata dopo il deploy?)',
    }
  }
  try {
    const dest = join(instanceDataDir, rel)
    if (io.exists(dest)) io.unlink(dest)
    io.mkdir(dirname(dest))
    io.link(winningSource.src, dest)
    return { ok: true, action, rel }
  } catch (e) {
    return { ok: false, action, rel, error: (e as Error).message }
  }
}
