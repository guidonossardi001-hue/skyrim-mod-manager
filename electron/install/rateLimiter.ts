// Rate limiter a token-bucket (gap Vortex: DownloadManager avvolge i download in un limiter
// opzionale oltre alla concorrenza). Un SOLO limiter condiviso tra tutti i download attivi —
// il budget è AGGREGATO (bytes/sec totali), non per-singolo-download, altrimenti N download
// concorrenti userebbero N volte la banda configurata.

export interface RateLimiter {
  /** Attende finché non ci sono `n` byte di budget disponibili, poi li consuma. Se il limite
   *  corrente è 0/assente risolve subito (nessun throttling) — mai un errore. */
  take(n: number): Promise<void>
}

/**
 * `getLimitBps` è una FUNZIONE, non un numero statico: legge il setting ad ogni chiamata, così
 * un cambio a runtime (l'utente alza/abbassa il limite nelle Impostazioni) si applica subito,
 * senza dover ricreare il limiter o riavviare i download in corso.
 */
export function createRateLimiter(getLimitBps: () => number | null | undefined): RateLimiter {
  let tokens = 0
  let lastRefill = Date.now()

  return {
    take(n: number): Promise<void> {
      return new Promise((resolve) => {
        const step = () => {
          const limit = getLimitBps()
          if (!limit || limit <= 0) {
            resolve() // nessun limite configurato: passa subito
            return
          }
          const now = Date.now()
          const elapsedSec = Math.max(0, (now - lastRefill) / 1000)
          lastRefill = now
          tokens = Math.min(limit, tokens + elapsedSec * limit)

          const consume = Math.min(n, tokens)
          tokens -= consume
          n -= consume
          if (n <= 0) {
            resolve()
            return
          }
          // Richiesta più grande del budget/secondo (chunk grande, limite basso): non
          // aspettare tutto in un colpo solo — ricontrolla al massimo ogni 200ms, così un
          // cambio di setting a metà attesa si applica comunque entro breve.
          const waitMs = Math.max(1, Math.min(200, Math.ceil((Math.min(n, limit) / limit) * 1000)))
          setTimeout(step, waitMs)
        }
        step()
      })
    },
  }
}
