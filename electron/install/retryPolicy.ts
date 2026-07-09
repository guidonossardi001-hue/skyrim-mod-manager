// ─────────────────────────────────────────────────────────────────────────────
// Shared retry / backoff / circuit-breaker policy.
//
// Extracted from downloadManager's previously-inline retry logic so there is ONE
// source of truth, used by BOTH the download queue and the mass-sync orchestrator
// (no divergent policies). Pure + injectable (clock/random) → fully unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

interface ErrLike {
  status?: number
  code?: string
  response?: { status?: number }
  message?: string
  cause?: { code?: string; message?: string }
}

// Node/undici network error codes that are transient and worth retrying.
// ENOTFOUND: DNS momentaneamente ko (offline breve, captive portal) — riprovabile.
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'EPROTO',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ESTALLED', // our own: a socket that connected then went idle past the stall timeout
])

export function httpStatusOf(e: unknown): number | undefined {
  const x = e as ErrLike
  return x?.status ?? x?.response?.status
}

/**
 * Retryable: 429 (rate limit), any 5xx (incl. Cloudflare 520-527), transient socket
 * errors (ECONNRESET/ETIMEDOUT/…), TLS/handshake resets, and Cloudflare "please try
 * again" bodies. NOT retryable: 401/403 (auth), 404 (gone), 400/422 (bad request).
 */
export function isRetryableError(e: unknown): boolean {
  const x = e as ErrLike
  const status = httpStatusOf(e)
  if (status === 429 || status === 408) return true // rate limit / request timeout
  if (status != null && status >= 500 && status <= 599) return true
  if (status != null && status >= 400 && status < 500) return false // other 4xx: do not retry
  const code = x?.code ?? x?.cause?.code
  if (code && RETRYABLE_CODES.has(code)) return true
  const msg = `${x?.message ?? ''} ${x?.cause?.message ?? ''}`.toLowerCase()
  return /socket hang up|econnreset|etimedout|timed? ?out|reset by peer|\btls\b|handshake|cloudflare|temporarily|try again|premature close|network error|connection (closed|reset|aborted)|download incompleto|incomplete download/.test(
    msg,
  )
}

/**
 * Exponential backoff with EQUAL jitter: delay ∈ [expo/2, expo], expo = min(cap, base·2^attempt).
 * attempt is 0-based (first retry → attempt 0). Jitter spreads a thundering herd of
 * concurrent downloads so they don't all re-hit the CDN on the same tick.
 */
export function backoffWithJitter(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 500,
    cap = opts.capMs ?? 8000,
    rnd = opts.random ?? Math.random
  const expo = Math.min(cap, base * 2 ** Math.max(0, attempt))
  return Math.round(expo / 2 + rnd() * (expo / 2))
}

/**
 * Circuit breaker: a run of consecutive failures (offline, expired key, CDN outage)
 * trips it OPEN so the orchestrator halts instead of burning through every queued mod.
 * A single success resets it.
 */
export class CircuitBreaker {
  private consecutive = 0
  constructor(private readonly threshold: number) {}
  recordSuccess(): void {
    this.consecutive = 0
  }
  recordFailure(): void {
    this.consecutive++
  }
  get failures(): number {
    return this.consecutive
  }
  isOpen(): boolean {
    return this.consecutive >= this.threshold
  }
  reset(): void {
    this.consecutive = 0
  }
}

/** A sleep that rejects promptly if the AbortSignal fires (keeps cancel responsive during backoff). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('annullato'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('annullato'))
      },
      { once: true },
    )
  })
}

export interface RetryConfig {
  maxRetries: number
  signal?: AbortSignal
  breaker?: CircuitBreaker
  baseMs?: number
  capMs?: number
  random?: () => number
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
}

/**
 * Run `fn`, retrying ONLY on retryable errors with jittered exponential backoff.
 * Stops immediately on: success, a non-retryable error, exhausted retries, an open
 * breaker, or abort. The breaker (if shared across callers) records success/failure.
 */
export async function withRetry<T>(fn: () => Promise<T>, cfg: RetryConfig): Promise<T> {
  let attempt = 0
  for (;;) {
    if (cfg.signal?.aborted) throw new Error('annullato')
    try {
      const out = await fn()
      cfg.breaker?.recordSuccess()
      return out
    } catch (err) {
      if (cfg.signal?.aborted) throw err // cancellation: never a retry
      cfg.breaker?.recordFailure()
      if (cfg.breaker?.isOpen()) throw err // systemic failure: stop, let caller halt
      if (!isRetryableError(err) || attempt >= cfg.maxRetries) throw err
      const delay = backoffWithJitter(attempt, { baseMs: cfg.baseMs, capMs: cfg.capMs, random: cfg.random })
      cfg.onRetry?.(attempt + 1, delay, err)
      await abortableSleep(delay, cfg.signal)
      attempt++
    }
  }
}
