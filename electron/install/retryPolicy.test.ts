import { describe, it, expect, vi } from 'vitest'
import {
  isRetryableError,
  backoffWithJitter,
  CircuitBreaker,
  abortableSleep,
  withRetry,
  httpStatusOf,
} from './retryPolicy'

describe('retryPolicy: classification', () => {
  it('retries 429, 5xx, Cloudflare 5xx, transient socket codes, TLS resets', () => {
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ response: { status: 503 } })).toBe(true)
    expect(isRetryableError({ status: 522 })).toBe(true) // Cloudflare connection timed out
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isRetryableError({ code: 'UND_ERR_SOCKET' })).toBe(true)
    expect(isRetryableError({ message: 'socket hang up' })).toBe(true)
    expect(isRetryableError({ message: 'TLS handshake failed' })).toBe(true)
    expect(isRetryableError({ cause: { code: 'ECONNRESET' } })).toBe(true)
    expect(isRetryableError({ message: 'Cloudflare: please try again' })).toBe(true)
  })
  it('does NOT retry auth/not-found/bad-request', () => {
    expect(isRetryableError({ status: 401 })).toBe(false)
    expect(isRetryableError({ status: 403 })).toBe(false)
    expect(isRetryableError({ status: 404 })).toBe(false)
    expect(isRetryableError({ status: 422 })).toBe(false)
    expect(isRetryableError({ message: 'md5 non combacia' })).toBe(false)
  })
  it('httpStatusOf reads status or response.status', () => {
    expect(httpStatusOf({ status: 500 })).toBe(500)
    expect(httpStatusOf({ response: { status: 429 } })).toBe(429)
  })
})

describe('retryPolicy: backoff with jitter', () => {
  it('grows exponentially and stays within [expo/2, expo], capped', () => {
    const r0 = backoffWithJitter(0, { random: () => 0 }) // expo 500 → 250
    const r0max = backoffWithJitter(0, { random: () => 1 }) // → 500
    expect(r0).toBe(250)
    expect(r0max).toBe(500)
    expect(backoffWithJitter(1, { random: () => 0 })).toBe(500) // expo 1000 → 500
    expect(backoffWithJitter(10, { random: () => 1 })).toBe(8000) // capped
    // jitter actually varies
    const a = backoffWithJitter(3, { random: () => 0.1 }),
      b = backoffWithJitter(3, { random: () => 0.9 })
    expect(a).not.toBe(b)
  })
})

describe('retryPolicy: circuit breaker', () => {
  it('opens after N consecutive failures, a success resets', () => {
    const cb = new CircuitBreaker(3)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(false)
    cb.recordFailure()
    expect(cb.isOpen()).toBe(true)
    cb.recordSuccess()
    expect(cb.isOpen()).toBe(false)
    expect(cb.failures).toBe(0)
  })
})

describe('retryPolicy: abortableSleep', () => {
  it('resolves after the delay and rejects immediately on abort', async () => {
    await expect(abortableSleep(5)).resolves.toBeUndefined()
    const ac = new AbortController()
    ac.abort()
    await expect(abortableSleep(1000, ac.signal)).rejects.toThrow(/annullato/)
  })
})

describe('retryPolicy: withRetry', () => {
  it('retries a transient error then succeeds (no real delay via random=0/base=0)', async () => {
    let n = 0
    const out = await withRetry(
      async () => {
        n++
        if (n < 3) throw { code: 'ECONNRESET' }
        return 'ok'
      },
      { maxRetries: 5, baseMs: 0, capMs: 0 },
    )
    expect(out).toBe('ok')
    expect(n).toBe(3)
  })
  it('does NOT retry a non-retryable error', async () => {
    let n = 0
    await expect(
      withRetry(
        async () => {
          n++
          throw { status: 403 }
        },
        { maxRetries: 5, baseMs: 0 },
      ),
    ).rejects.toBeTruthy()
    expect(n).toBe(1)
  })
  it('gives up after maxRetries', async () => {
    let n = 0
    await expect(
      withRetry(
        async () => {
          n++
          throw { code: 'ETIMEDOUT' }
        },
        { maxRetries: 2, baseMs: 0 },
      ),
    ).rejects.toBeTruthy()
    expect(n).toBe(3) // initial + 2 retries
  })
  it('stops when the shared breaker trips open', async () => {
    const cb = new CircuitBreaker(2)
    let n = 0
    await expect(
      withRetry(
        async () => {
          n++
          throw { code: 'ECONNRESET' }
        },
        { maxRetries: 10, baseMs: 0, breaker: cb },
      ),
    ).rejects.toBeTruthy()
    expect(cb.isOpen()).toBe(true)
    expect(n).toBe(2) // 2 failures trip the breaker → no more attempts
  })
  it('aborts promptly without retrying', async () => {
    const ac = new AbortController()
    let n = 0
    const p = withRetry(
      async () => {
        n++
        ac.abort()
        throw { code: 'ECONNRESET' }
      },
      { maxRetries: 5, baseMs: 0, signal: ac.signal },
    )
    await expect(p).rejects.toBeTruthy()
    expect(n).toBe(1)
  })
})
