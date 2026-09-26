/**
 * The TLS listener's CONNECTION-LEVEL behaviour.
 *
 * The gate is never reached for a connection that fails its handshake, so this
 * suite drives the listener directly with raw sockets:
 *
 * - a plaintext HTTP client on the TLS port used to receive ZERO bytes, which a
 *   browser reports as `ERR_EMPTY_RESPONSE` / -324 with no hint of what went
 *   wrong (user report 2026-09-26). It must now be redirected to the same
 *   address over `https`;
 * - a real TLS client must be unaffected by that redirect;
 * - both failures must be visible in the log, because they are invisible from
 *   the gate's side.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { connect, type Socket } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { startLanGuard, type LanGuardRuntime } from '../src/index.ts'
import type { LanGuardLogger } from '../src/log.ts'
import { startFakeDsh, type FakeDsh } from './helpers/fake-dsh.ts'
import { tmpDataDir } from './helpers/tmp.ts'

let fake: FakeDsh | undefined
let runtime: LanGuardRuntime | undefined

/** The gate password every case configures, so the gate is really reached. */
const PASSWORD = 'correct horse battery staple'

afterEach(async () => {
  await runtime?.close()
  await fake?.close()
  runtime = undefined
  fake = undefined
})

/** A logger that records every line, so the suite can assert what was reported. */
function recordingLogger(): { logger: LanGuardLogger; lines: string[] } {
  const lines: string[] = []
  // The real logger is printf-style; substituting here keeps the assertions
  // readable as the operator would actually read the line.
  const record = (level: string) => (message: string, ...args: unknown[]) => {
    let index = 0
    const formatted = message.replaceAll(/%[sd]/g, () => String(args[index++] ?? ''))
    const rest = args.slice(index).map(value => String(value)).join(' ')
    lines.push(`${level} ${formatted}${rest === '' ? '' : ` ${rest}`}`)
  }
  return { logger: { info: record('info'), warn: record('warn'), debug: record('debug') }, lines }
}

/** Bring up the real listener, over a fake upstream. */
async function harness(
  config: Record<string, unknown> = {},
): Promise<{ port: number; lines: string[] }> {
  const upstream = await startFakeDsh()
  const { logger, lines } = recordingLogger()
  const started = await startLanGuard({ authenticatedUrl: upstream.authenticatedUrl, logger }, {
    dataDir: await tmpDataDir(),
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    tls: { mode: 'self-signed' },
    ...config,
    // The suite connects from loopback, so the gate must be exercised rather
    // than exempted.
    auth: { allowLoopback: false, ...((config.auth as object | undefined) ?? {}) },
  })
  if (started === undefined) throw new Error('plugin did not start')
  // A password must exist, otherwise the gate answers 403 "no password
  // configured" and the listener's own behaviour is masked.
  await started.auth.setPassword(PASSWORD)
  fake = upstream
  runtime = started
  return { port: started.proxy.port, lines }
}

/** Send raw bytes and collect whatever comes back until the peer closes. */
function rawExchange(port: number, payload: string): Promise<{ response: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setTimeout(4_000, () => {
      socket.destroy()
      resolve({ response, socket })
    })
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
    })
    socket.on('close', () => resolve({ response, socket }))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(payload))
  })
}

/** One https GET, trusting the self-signed listener. */
function httpsGet(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port,
      path,
      rejectUnauthorized: false,
      headers: { accept: 'text/html' },
    }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('plaintext HTTP on the TLS port', () => {
  it('redirects to https instead of answering with nothing', async () => {
    const { port } = await harness()

    const { response } = await rawExchange(port, 'GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n')

    // The whole point: a non-empty reply, and one the browser can act on.
    expect(response).not.toBe('')
    expect(response.startsWith('HTTP/1.1 301 Moved Permanently')).toBe(true)
    expect(response.toLowerCase()).toContain(`location: https://127.0.0.1:${String(port)}/`)
    // A body-less redirect must not make the browser wait for one.
    expect(response.toLowerCase()).toContain('content-length: 0')
  })

  it('reports the failure with its cause and peer address', async () => {
    const { port, lines } = await harness()
    await rawExchange(port, 'GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n')

    const warned = lines.find(line => line.includes('tls handshake failed'))
    expect(warned).toBeDefined()
    expect(warned).toContain('code=ERR_SSL_HTTP_REQUEST')
    expect(warned).toContain('plaintextHttp=yes')
    expect(warned).toContain('ip=127.0.0.1')
  })

  it('leaves a real TLS client completely unaffected', async () => {
    const { port } = await harness()

    // Plaintext first, then TLS, then TLS again: the redirect must not poison
    // the listener for the clients it exists to serve.
    await rawExchange(port, 'GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n')
    const first = await httpsGet(port)
    expect(first.status).toBe(401)
    expect(first.body).toContain('访问密码')

    const second = await httpsGet(port)
    expect(second.status).toBe(401)
  })
})

describe('malformed requests', () => {
  it('answers 400 like Node does, and says so in the log', async () => {
    const { port, lines } = await harness({ tls: { mode: 'off' } })

    const { response } = await rawExchange(port, '\u0001BAD / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n')

    // Attaching a clientError listener REPLACES Node's default handler, so the
    // suite proves the default 400 was reproduced rather than lost.
    expect(response).toContain('400 Bad Request')
    const warned = lines.find(line => line.includes('malformed request'))
    expect(warned).toBeDefined()
    expect(warned).toContain('ip=127.0.0.1')
  })

  it('serves plain HTTP normally when TLS is off', async () => {
    const { port } = await harness({ tls: { mode: 'off' } })
    const { response } = await rawExchange(port, 'GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n')
    expect(response).toContain('401')
    expect(response).not.toContain('301')
  })
})
