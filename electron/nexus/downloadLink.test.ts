import { describe, it, expect } from 'vitest'
import {
  buildDownloadLinkRequest,
  parseDownloadLink,
  resolveDownloadLink,
  DownloadLinkError,
  type HttpGetJson,
} from './downloadLink'
import { isRetryableError } from '../install/retryPolicy'

describe('Nexus download_link request building', () => {
  it('uses the apikey header for a personal API key', () => {
    const { url, headers } = buildDownloadLinkRequest({ modId: 266, fileId: 9999, apiKey: 'secret' })
    expect(url).toBe(
      'https://api.nexusmods.com/v1/games/skyrimspecialedition/mods/266/files/9999/download_link.json',
    )
    expect(headers.apikey).toBe('secret')
    expect(headers.Authorization).toBeUndefined()
    expect(headers['User-Agent']).toMatch(/SkyrimAEModManager/)
    expect(headers.Accept).toBe('application/json')
  })

  it('prefers an Authorization: Bearer token when given (OAuth)', () => {
    const { headers } = buildDownloadLinkRequest({ modId: 1, fileId: 2, apiKey: 'k', bearerToken: 'tok' })
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers.apikey).toBeUndefined() // bearer wins
  })

  it('appends nxm key/expires as query params for non-premium manual downloads', () => {
    const { url } = buildDownloadLinkRequest({
      modId: 1,
      fileId: 2,
      apiKey: 'k',
      key: 'abc',
      expires: 1719200000,
    })
    expect(url).toContain('?key=abc&expires=1719200000')
  })

  it('honours a custom game domain', () => {
    const { url } = buildDownloadLinkRequest({ modId: 5, fileId: 6, apiKey: 'k', game: 'fallout4' })
    expect(url).toContain('/games/fallout4/mods/5/files/6/')
  })
})

describe('Nexus download_link parsing', () => {
  it('returns the first usable URI', () => {
    expect(parseDownloadLink([{ name: 'CDN', URI: 'https://cdn/x.7z' }])).toBe('https://cdn/x.7z')
  })
  it('throws on an empty or malformed response', () => {
    expect(() => parseDownloadLink([])).toThrow(/alcun link/i)
    expect(() => parseDownloadLink([{ name: 'no-uri' }])).toThrow(/URI/i)
    expect(() => parseDownloadLink('nope')).toThrow()
  })
})

describe('Nexus download_link resolution + error mapping', () => {
  const ok =
    (data: unknown): HttpGetJson =>
    async () => ({ status: 200, data })
  const failStatus =
    (status: number): HttpGetJson =>
    async () => {
      throw Object.assign(new Error('http error'), { response: { status } })
    }

  it('resolves a direct URI on success', async () => {
    expect(
      await resolveDownloadLink(ok([{ URI: 'https://cdn/a.7z' }]), { modId: 1, fileId: 2, apiKey: 'k' }),
    ).toBe('https://cdn/a.7z')
  })

  it('maps 403/401 to a Premium-required message', async () => {
    await expect(resolveDownloadLink(failStatus(403), { modId: 1, fileId: 2, apiKey: 'k' })).rejects.toThrow(
      /Premium/i,
    )
    await expect(resolveDownloadLink(failStatus(401), { modId: 1, fileId: 2, apiKey: 'k' })).rejects.toThrow(
      /Premium/i,
    )
  })

  it('maps 404 and 429 to clear messages', async () => {
    await expect(resolveDownloadLink(failStatus(404), { modId: 1, fileId: 2, apiKey: 'k' })).rejects.toThrow(
      /non trovato/i,
    )
    await expect(resolveDownloadLink(failStatus(429), { modId: 1, fileId: 2, apiKey: 'k' })).rejects.toThrow(
      /429/,
    )
  })

  it('refuses to call out with no credential at all', async () => {
    let called = false
    const spy: HttpGetJson = async () => {
      called = true
      return { status: 200, data: [] }
    }
    await expect(resolveDownloadLink(spy, { modId: 1, fileId: 2 })).rejects.toThrow(/credenziale/i)
    expect(called).toBe(false)
  })

  // HARDENING: the friendly message must NOT lose the HTTP status, or the retry policy
  // misreads a transient 429/5xx as permanent and never retries link resolution.
  it('preserves the HTTP status so transient resolve failures are retryable', async () => {
    const grab = (status: number) =>
      resolveDownloadLink(failStatus(status), { modId: 1, fileId: 2, apiKey: 'k' }).catch((e) => e)

    const e429 = await grab(429)
    expect(e429).toBeInstanceOf(DownloadLinkError)
    expect(e429.status).toBe(429)
    expect(isRetryableError(e429)).toBe(true)

    const e503 = await grab(503) // Cloudflare/CDN hiccup
    expect(e503.status).toBe(503)
    expect(isRetryableError(e503)).toBe(true)

    const e403 = await grab(403) // auth: must stay permanent
    expect(e403.status).toBe(403)
    expect(isRetryableError(e403)).toBe(false)

    const e404 = await grab(404) // gone: permanent
    expect(isRetryableError(e404)).toBe(false)
  })

  it('carries a transient socket error (no status) through as retryable via cause', async () => {
    const netFail: HttpGetJson = async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    }
    const err = await resolveDownloadLink(netFail, { modId: 1, fileId: 2, apiKey: 'k' }).catch((e) => e)
    expect(err).toBeInstanceOf(DownloadLinkError)
    expect(err.status).toBeUndefined()
    expect(isRetryableError(err)).toBe(true) // classified via cause.code = ECONNRESET
  })
})
