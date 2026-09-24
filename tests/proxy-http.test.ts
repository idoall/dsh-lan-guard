/**
 * HTTP proxy integration tests (docs/SPEC.md F1/F2, §7).
 *
 * Everything runs against a fake upstream on `127.0.0.1:0` and a proxy on
 * `127.0.0.1:0`: the suite never binds a network interface and never needs a
 * real DSH process (docs/SPEC.md §7 "约束").
 */
import { afterEach, describe, expect, it } from 'vitest'
import { noopLogger } from '../src/log.ts'
import { startProxy, type RunningProxy } from '../src/proxy.ts'
import { UpstreamAuth } from '../src/upstream-auth.ts'
import { startFakeDsh, type FakeDsh, type FakeDshOptions } from './helpers/fake-dsh.ts'
import { requestTo } from './helpers/http-client.ts'

let fake: FakeDsh | undefined
let proxy: RunningProxy | undefined

/** Bring up a fake upstream plus a proxy in front of it. */
async function harness(options: FakeDshOptions = {}): Promise<{ fake: FakeDsh; proxy: RunningProxy }> {
  const upstream = await startFakeDsh(options)
  const running = await startProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    auth: new UpstreamAuth({ origin: upstream.origin, authenticatedUrl: upstream.authenticatedUrl }),
    logger: noopLogger,
  })
  fake = upstream
  proxy = running
  return { fake: upstream, proxy: running }
}

afterEach(async () => {
  await proxy?.close()
  await fake?.close()
  proxy = undefined
  fake = undefined
})

describe('HTTP forwarding', () => {
  it('serves the DSH index instead of a 401', async () => {
    const { proxy: running } = await harness()
    const response = await requestTo(running.port, { path: '/' })
    expect(response.status).toBe(200)
    expect(response.body.toString()).toContain('fake dsh index')
  })

  it('lands a bare-origin request (no trailing slash) on /', async () => {
    const { proxy: running } = await harness()
    const response = await requestTo(running.port, { path: `http://127.0.0.1:${String(running.port)}` })
    expect(response.status).toBe(200)
    expect(response.body.toString()).toContain('fake dsh index')
  })

  it('rewrites host and origin to the upstream authority and injects the loopback cookie', async () => {
    const { fake: upstream, proxy: running } = await harness()
    const response = await requestTo(running.port, {
      path: '/',
      headers: { host: '192.168.1.5:3445', origin: 'http://192.168.1.5:3445' },
    })
    expect(response.status).toBe(200)

    // observed[0] is the token exchange; the forwarded request is the next one.
    const forwarded = upstream.observed.find(entry => !entry.url.includes('token='))
    expect(forwarded?.url).toBe('/')
    expect(forwarded?.headers.host).toBe(upstream.authority)
    expect(forwarded?.headers.origin).toBe(`http://${upstream.authority}`)
    expect(forwarded?.headers.cookie).toMatch(/^dsh-auth-/)
    expect(JSON.stringify(forwarded?.headers)).not.toContain('192.168.1.5')
  })

  it('forwards /api/* unary RPC requests and preserves the query string', async () => {
    const { fake: upstream, proxy: running } = await harness({
      routes: {
        '/api/x': (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        },
      },
    })
    const response = await requestTo(running.port, { path: '/api/x?rev=abc&n=1' })
    expect(response.status).toBe(200)
    expect(response.body.toString()).toBe('{"ok":true}')
    expect(upstream.observed.at(-1)?.url).toBe('/api/x?rev=abc&n=1')
  })

  it('passes plugin bundles through untouched (document-relative form, no URL rewriting)', async () => {
    const source = 'export const x = "plugins/x";'
    const { fake: upstream, proxy: running } = await harness({
      routes: {
        '/plugins/x.js': (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'private, max-age=31536000, immutable' })
          res.end(source)
        },
      },
    })
    const response = await requestTo(running.port, { path: '/plugins/x.js?rev=deadbeef' })
    expect(response.status).toBe(200)
    expect(response.body.toString()).toBe(source)
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(upstream.observed.at(-1)?.url).toBe('/plugins/x.js?rev=deadbeef')
  })

  it('forwards a request body unchanged', async () => {
    const { fake: upstream, proxy: running } = await harness({
      routes: {
        '/echo': (req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            const body = Buffer.concat(chunks)
            res.writeHead(200, { 'content-type': 'application/octet-stream' })
            res.end(body)
          })
        },
      },
    })
    const payload = Buffer.from([0x00, 0x01, 0xff, 0x42])
    const response = await requestTo(running.port, { method: 'POST', path: '/echo', body: payload })
    expect(response.status).toBe(200)
    expect(response.body.equals(payload)).toBe(true)
    expect(upstream.observed.at(-1)?.method).toBe('POST')
  })

  it('drops the upstream session cookie instead of relaying it', async () => {
    const { proxy: running } = await harness({
      routes: {
        '/with-cookie': (_req, res) => {
          res.writeHead(200, { 'set-cookie': 'upstream-leak=1; HttpOnly', 'content-type': 'text/plain' })
          res.end('ok')
        },
      },
    })
    const response = await requestTo(running.port, { path: '/with-cookie' })
    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('never forwards hop-by-hop response headers', async () => {
    const { proxy: running } = await harness({
      routes: {
        '/hop': (_req, res) => {
          res.writeHead(200, {
            'content-type': 'text/plain',
            // Hop-by-hop headers the upstream must not be able to push through.
            // (`connection`/`transfer-encoding` are excluded from the assertion
            // below: Node re-frames OUR hop and legitimately sets its own.)
            te: 'trailers',
            trailer: 'x-checksum',
            'proxy-authenticate': 'Basic realm="upstream"',
            'keep-alive': 'timeout=99',
          })
          res.end('ok')
        },
      },
    })
    const response = await requestTo(running.port, { path: '/hop' })
    expect(response.status).toBe(200)
    expect(response.headers.te).toBeUndefined()
    expect(response.headers.trailer).toBeUndefined()
    expect(response.headers['proxy-authenticate']).toBeUndefined()
    // Node re-frames OUR hop and may set its own Keep-Alive; the upstream's
    // value must never be the one that arrives.
    expect(response.headers['keep-alive']).not.toBe('timeout=99')
  })
})

describe('response bodies', () => {
  it('passes multipart/form-data through byte for byte', async () => {
    const boundary = 'dsh-lan-guard-boundary'
    const binary = Buffer.from([0x00, 0x01, 0xff, 0x0d, 0x0a, 0x42, 0x00, 0x80])
    const expected = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json\r\n\r\n{"ok":true}\r\n`
        + `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      binary,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const { proxy: running } = await harness({
      routes: {
        '/multipart': (_req, res) => {
          res.writeHead(200, {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': String(expected.length),
          })
          res.end(expected)
        },
      },
    })
    const response = await requestTo(running.port, { path: '/multipart' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(`multipart/form-data; boundary=${boundary}`)
    expect(response.body.equals(expected)).toBe(true)
  })

  it('streams a large response without buffering it', async () => {
    let secondWrittenAt = 0
    const { proxy: running } = await harness({
      routes: {
        '/stream': (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.write(Buffer.alloc(256 * 1024, 0x61))
          setTimeout(() => {
            secondWrittenAt = Date.now()
            res.write(Buffer.alloc(256 * 1024, 0x62))
            res.end()
          }, 150)
        },
      },
    })

    let firstChunkAt = 0
    const { request } = await import('node:http')
    const total = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: running.port, path: '/stream' }, (res) => {
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          if (firstChunkAt === 0) firstChunkAt = Date.now()
          bytes += chunk.length
        })
        res.on('end', () => resolve(bytes))
      })
      req.on('error', reject)
      req.end()
    })

    expect(total).toBe(512 * 1024)
    expect(firstChunkAt).toBeGreaterThan(0)
    expect(secondWrittenAt).toBeGreaterThan(0)
    // The first half reached the client BEFORE the upstream wrote the second
    // half, which is only possible if nothing buffered the response.
    expect(firstChunkAt).toBeLessThan(secondWrittenAt)
  })
})

describe('port fallback', () => {
  it('walks to the next free port when the configured one is taken', async () => {
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const taken = typeof address === 'object' && address !== null ? address.port : 0

    const upstream = await startFakeDsh()
    const running = await startProxy({
      listenHost: '127.0.0.1',
      listenPort: taken,
      portProbeAttempts: 5,
      upstreamOrigin: upstream.origin,
      auth: new UpstreamAuth({ origin: upstream.origin, authenticatedUrl: upstream.authenticatedUrl }),
      logger: noopLogger,
    })
    fake = upstream
    proxy = running
    expect(running.portFallback).toBe(true)
    expect(running.requestedPort).toBe(taken)
    expect(running.port).toBeGreaterThan(taken)

    const response = await requestTo(running.port, { path: '/' })
    expect(response.status).toBe(200)
    await new Promise<void>(resolve => blocker.close(() => resolve()))
  })
})

describe('failure handling', () => {
  it('answers 502 when the upstream is unreachable', async () => {
    const { fake: upstream } = await harness()
    await upstream.close()
    // Keep a proxy whose upstream is now gone.
    const dead = await startProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: upstream.origin,
      auth: new UpstreamAuth({ origin: upstream.origin, authenticatedUrl: upstream.authenticatedUrl }),
      logger: noopLogger,
    })
    proxy = dead
    const response = await requestTo(dead.port, { path: '/' })
    expect(response.status).toBe(502)
    expect(response.body.toString()).toContain('upstream')
    fake = undefined
  })

  it('re-authenticates and retries once when the upstream answers 401', async () => {
    const { fake: upstream, proxy: running } = await harness({ unauthorizedOnce: true })
    const response = await requestTo(running.port, { path: '/' })
    expect(response.status).toBe(200)
    expect(upstream.exchangeCount()).toBe(2)
  })

  it('does not retry a body-carrying method after a 401', async () => {
    const { fake: upstream, proxy: running } = await harness({ alwaysUnauthorized: true })
    const response = await requestTo(running.port, { method: 'POST', path: '/api/x', body: 'payload' })
    expect(response.status).toBe(401)
    expect(upstream.exchangeCount()).toBe(1)
  })
})
