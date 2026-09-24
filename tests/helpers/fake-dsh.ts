/**
 * A fake DSH loopback web server for the P1 suite.
 *
 * It reproduces the two upstream behaviours the proxy depends on, both taken
 * from the real implementation (docs/RESEARCH.md §3.2/§3.3):
 *
 * 1. `GET /?token=<launch token>` → `303` + `Set-Cookie` + `Location: ./`.
 *    The cookie NAME is a hash of the request authority, so a test can prove
 *    the proxy rewrote `host` to the upstream authority and injected a cookie
 *    bound to it.
 * 2. Every other request needs that cookie, otherwise it gets DSH's minimal
 *    `401` — the exact failure mode route A exists to avoid.
 *
 * It binds `127.0.0.1` with port `0` only: the suite must never listen on a
 * network interface (docs/SPEC.md §7 "约束").
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

/** One request the fake upstream observed. */
export interface ObservedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

/** One upgrade the fake upstream observed. */
export interface ObservedUpgrade {
  url: string
  headers: IncomingHttpHeaders
}

/** Handler for a non-exchange route. */
export type FakeRoute = (req: IncomingMessage, res: ServerResponse) => void

/** Options for {@link startFakeDsh}. */
export interface FakeDshOptions {
  /** The launch token the exchange expects. */
  launchToken?: string
  /** `Max-Age` in seconds for the minted cookie. */
  cookieMaxAgeSeconds?: number
  /** Route table keyed by pathname; falls back to the index document. */
  routes?: Record<string, FakeRoute>
  /** Answer authenticated requests with 401 anyway (simulates a rotated cookie). */
  alwaysUnauthorized?: boolean
  /** Answer only the FIRST authenticated request with 401 (drives the proxy's retry path). */
  unauthorizedOnce?: boolean
  /** Answer the exchange with a non-303 status. */
  exchangeStatus?: number
  /** Omit the `Set-Cookie` header from the exchange response. */
  exchangeWithoutCookie?: boolean
  /** Extra headers added to the WebSocket 101 (the proxy must drop them). */
  upgradeExtraHeaders?: Record<string, string>
}

/** A running fake upstream. */
export interface FakeDsh {
  /** Base origin, e.g. `http://127.0.0.1:53123`. */
  origin: string
  /** `host:port` authority. */
  authority: string
  /** The `ctx.connection.authenticatedUrl` stand-in. */
  authenticatedUrl: (baseUrl: string) => string
  /** Every HTTP request seen, in order. */
  observed: ObservedRequest[]
  /** Every upgrade seen, in order. */
  observedUpgrades: ObservedUpgrade[]
  /** How many token→cookie exchanges were performed. */
  exchangeCount: () => number
  /** Close the listener. */
  close: () => Promise<void>
}

const INDEX_HTML = '<!doctype html><html><head><base href="./"></head><body>fake dsh index</body></html>'

/** The cookie name DSH derives from the request authority. */
export function fakeCookieName(authority: string): string {
  const digest = createHash('sha256').update(authority).digest('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return `dsh-auth-${digest}`
}

/** The WebSocket accept value from RFC 6455. */
function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

/** Read the value of one cookie by name. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Start the fake upstream on `127.0.0.1:0`.
 *
 * @param options - see {@link FakeDshOptions}.
 * @returns the running fake upstream.
 */
export async function startFakeDsh(options: FakeDshOptions = {}): Promise<FakeDsh> {
  const launchToken = options.launchToken ?? 'fake-launch-token'
  const cookieMaxAgeSeconds = options.cookieMaxAgeSeconds ?? 2_592_000
  const observed: ObservedRequest[] = []
  const observedUpgrades: ObservedUpgrade[] = []
  let exchangeCount = 0
  let authenticatedRequests = 0
  let authority = ''
  const openSockets = new Set<Duplex>()
  let cookiePair = ''

  const unauthorized = (res: ServerResponse): void => {
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  }

  const server: Server = createServer((req, res) => {    observed.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })

    const url = new URL(req.url ?? '/', 'http://fake.invalid')
    const tokens = url.searchParams.getAll('token')
    if (tokens.length > 0) {
      exchangeCount += 1
      if (options.exchangeStatus !== undefined && options.exchangeStatus !== 303) {
        res.writeHead(options.exchangeStatus)
        res.end()
        return
      }
      const headers: Record<string, string | string[]> = {
        'cache-control': 'no-store',
        location: './',
        'referrer-policy': 'no-referrer',
      }
      if (options.exchangeWithoutCookie !== true) {
        const expiresAt = Date.now() + cookieMaxAgeSeconds * 1_000
        cookiePair = `${fakeCookieName(authority)}=v1.fake-payload.fake-signature`
        headers['set-cookie'] =
          `${cookiePair}; Max-Age=${String(cookieMaxAgeSeconds)}; Path=/; `
          + `Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
      }
      res.writeHead(303, headers)
      res.end()
      return
    }

    const host = req.headers.host
    const name = host === undefined ? '' : fakeCookieName(new URL(`http://${host}`).host)
    const presented = cookieValue(req.headers.cookie, name)
    const rotated = options.unauthorizedOnce === true && authenticatedRequests === 0
    authenticatedRequests += 1
    if (
      options.alwaysUnauthorized === true
      || rotated
      || cookiePair === ''
      || presented !== cookiePair.split('=')[1]
    ) {
      unauthorized(res)
      return
    }

    const route = options.routes?.[url.pathname]
    if (route !== undefined) {
      route(req, res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(INDEX_HTML)
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
    observedUpgrades.push({ url: req.url ?? '', headers: req.headers })
    const host = req.headers.host
    const name = host === undefined ? '' : fakeCookieName(new URL(`http://${host}`).host)
    const presented = cookieValue(req.headers.cookie, name)
    const authorized = cookiePair !== '' && presented === cookiePair.split('=')[1]
    if (options.alwaysUnauthorized === true || !authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'upgrade: websocket',
      'connection: Upgrade',
      `sec-websocket-accept: ${websocketAccept(key)}`,
      ...Object.entries(options.upgradeExtraHeaders ?? {}).map(([name, value]) => `${name}: ${value}`),
    ]
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) socket.write(head)
    // Echo: enough to prove both directions of the tunnel carry bytes.
    socket.on('data', (chunk: Buffer) => {
      socket.write(chunk)
    })
    socket.on('error', () => socket.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo
  authority = `127.0.0.1:${String(address.port)}`
  const origin = `http://${authority}`

  return {
    origin,
    authority,
    authenticatedUrl: (baseUrl: string) => {
      const url = new URL(baseUrl)
      url.searchParams.set('token', launchToken)
      return url.href
    },
    observed,
    observedUpgrades,
    exchangeCount: () => exchangeCount,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.()
      // Upgraded sockets leave the server's own connection tracking, so they
      // must be torn down explicitly or close() would never settle.
      for (const socket of openSockets) socket.destroy()
      openSockets.clear()
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    }),
  }
}
