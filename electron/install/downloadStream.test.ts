import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import axios from 'axios'
import { parseContentRange, planResume, streamToFile, StallError, type HttpGet } from './downloadStream'
import { isRetryableError } from './retryPolicy'

const http: HttpGet = (url, cfg) => axios.get(url, cfg as never) as never

const servers: Server[] = []
function serve(body: Buffer, opts: { supportRange?: boolean; fakeLen?: number } = {}): Promise<string> {
  const supportRange = opts.supportRange ?? true
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const range = req.headers.range
      if (supportRange && range) {
        const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
        const chunk = body.subarray(start)
        res.writeHead(206, {
          'content-length': String(chunk.length),
          'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
        })
        res.end(chunk)
      } else {
        res.writeHead(200, { 'content-length': String(opts.fakeLen ?? body.length) })
        res.end(body)
      }
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/file.7z`),
    )
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smm-dl-'))
})
afterEach(() => {
  while (servers.length) servers.pop()!.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('downloadStream: pure helpers', () => {
  it('parseContentRange parses bytes start-end/total', () => {
    expect(parseContentRange('bytes 200-1023/1024')).toEqual({ start: 200, end: 1023, total: 1024 })
    expect(parseContentRange(undefined)).toBeNull()
    expect(parseContentRange('garbage')).toBeNull()
  })
  it('planResume appends only on 206 with a partial', () => {
    expect(planResume(500, 206)).toEqual({ append: true, startOffset: 500 })
    expect(planResume(500, 200)).toEqual({ append: false, startOffset: 0 })
    expect(planResume(0, 206)).toEqual({ append: false, startOffset: 0 })
  })
})

describe('downloadStream: real socket transfer', () => {
  const body = Buffer.from('A'.repeat(5000) + 'B'.repeat(5000))

  it('streams a full file to disk and promotes the .part atomically', async () => {
    const url = await serve(body)
    const dest = join(dir, 'mod.7z')
    let progressed = false
    const r = await streamToFile({
      url,
      destPath: dest,
      http,
      progressIntervalMs: 0,
      onProgress: () => {
        progressed = true
      },
    })
    expect(r).toMatchObject({ bytes: body.length, total: body.length, resumed: false })
    expect(existsSync(dest + '.part')).toBe(false) // promoted
    expect(readFileSync(dest).equals(body)).toBe(true)
    expect(progressed).toBe(true)
  })

  it('resumes from a .part via Range and reassembles the exact file', async () => {
    const url = await serve(body)
    const dest = join(dir, 'mod.7z')
    writeFileSync(dest + '.part', body.subarray(0, 4000)) // simulate an interrupted download
    const r = await streamToFile({ url, destPath: dest, http })
    expect(r.resumed).toBe(true)
    expect(r.bytes).toBe(body.length)
    expect(readFileSync(dest).equals(body)).toBe(true) // first 4000 + ranged remainder
  })

  it('restarts cleanly when the server ignores Range (200)', async () => {
    const url = await serve(body, { supportRange: false })
    const dest = join(dir, 'mod.7z')
    writeFileSync(dest + '.part', body.subarray(0, 4000))
    const r = await streamToFile({ url, destPath: dest, http })
    expect(r.resumed).toBe(false)
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('promotes an already-complete .part when the server answers 416', async () => {
    // Crash dopo il download ma prima della promozione: il .part è COMPLETO, la
    // Range parte oltre la fine e il server risponde 416 con "bytes */<total>".
    const stub: HttpGet = async () => ({
      status: 416,
      headers: { 'content-range': `bytes */${body.length}` },
      data: Readable.from([]),
    })
    const dest = join(dir, 'mod.7z')
    writeFileSync(dest + '.part', body) // .part già completo
    const r = await streamToFile({ url: 'http://x/file.7z', destPath: dest, http: stub })
    expect(r).toMatchObject({ bytes: body.length, total: body.length, resumed: true })
    expect(existsSync(dest + '.part')).toBe(false) // promoted
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  it('rejects a 416 whose .part size does not match the remote total', async () => {
    const stub: HttpGet = async () => ({
      status: 416,
      headers: { 'content-range': `bytes */${body.length}` },
      data: Readable.from([]),
    })
    const dest = join(dir, 'mod.7z')
    writeFileSync(dest + '.part', Buffer.concat([body, Buffer.from('junk')])) // .part oltre il totale remoto
    await expect(streamToFile({ url: 'http://x/file.7z', destPath: dest, http: stub })).rejects.toThrow(
      /Ripresa impossibile/i,
    )
    expect(existsSync(dest)).toBe(false)
  })

  it('fails closed when the stream ends short of the declared total (no final file)', async () => {
    // Injected stub: a stream that ends cleanly after 5 bytes while Content-Length
    // declares 55 → the integrity check must reject and the .part must NOT be promoted.
    const buf = Buffer.from('hello')
    const stub: HttpGet = async () => ({
      status: 200,
      headers: { 'content-length': String(buf.length + 50) },
      data: Readable.from([buf]),
    })
    const dest = join(dir, 'mod.7z')
    await expect(streamToFile({ url: 'http://x/file.7z', destPath: dest, http: stub })).rejects.toThrow(
      /incompleto/i,
    )
    expect(existsSync(dest)).toBe(false)
  })
})

describe('downloadStream: stall guard (HARDENING)', () => {
  it('aborts a connect that never sends headers, with a RETRYABLE StallError', async () => {
    const hang: HttpGet = () => new Promise(() => {}) // socket accepted, headers never arrive
    const dest = join(dir, 'mod.7z')
    const err = await streamToFile({
      url: 'http://x/file.7z',
      destPath: dest,
      http: hang,
      stallTimeoutMs: 40,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(StallError)
    expect(isRetryableError(err)).toBe(true) // ESTALLED → withRetry will re-attempt
  })

  it('aborts a body that stops sending bytes (idle stall) and never promotes', async () => {
    const stub: HttpGet = async () => ({
      status: 200,
      headers: { 'content-length': '100000' },
      data: new Readable({ read() {} }), // emits nothing and never ends
    })
    const dest = join(dir, 'mod.7z')
    const err = await streamToFile({
      url: 'http://x/file.7z',
      destPath: dest,
      http: stub,
      stallTimeoutMs: 40,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(StallError)
    expect(existsSync(dest)).toBe(false) // not promoted; .part left for resume
  })

  it('a user cancel stays an AbortError — NOT misclassified as a retryable stall', async () => {
    const ac = new AbortController()
    const stub: HttpGet = async () => ({
      status: 200,
      headers: { 'content-length': '100000' },
      data: new Readable({ read() {} }),
    })
    const dest = join(dir, 'mod.7z')
    const p = streamToFile({
      url: 'http://x/file.7z',
      destPath: dest,
      http: stub,
      signal: ac.signal,
      stallTimeoutMs: 10_000, // long: the cancel must win, not the stall timer
    }).catch((e) => e)
    setTimeout(() => ac.abort(), 20)
    const err = await p
    expect(err).not.toBeInstanceOf(StallError)
  })
})
