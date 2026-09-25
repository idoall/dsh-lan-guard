/**
 * dsh-lan-guard — the reverse proxy itself.
 *
 * The proxy owns its own listener; it never touches DSH's binding. Requests are relayed transparently to the
 * loopback upstream:
 *
 * - HTTP: one `http.request` per visitor request, streamed both ways. Nothing
 *   is buffered, so a large or streaming response keeps its semantics.
 * - WebSocket: the upgrade is relayed by {@link forwardUpgrade}.
 * - A `401` from the upstream means our cached loopback cookie died (DSH
 *   restarted, or the cookie was rotated). For a safe method the request is
 *   re-authenticated and retried ONCE — never for a body-carrying method.
 *
 * The gate is NOT part of this module's P1 scope; P2 inserts it in front of
 * both the HTTP and the upgrade path.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import {
  authorityOf,
  buildUpstreamRequestHeaders,
  buildUpstreamResponseHeaders,
  normalizeRequestTarget,
} from './headers.ts'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'
import type { VisitorGate } from './auth/gate.ts'
import type { UpstreamAuth } from './upstream-auth.ts'
import { forwardUpgrade, guardUpgradeSocket, type UpstreamTarget } from './websocket.ts'

/** Options for {@link startProxy}. */
export interface ProxyOptions {
  /** Bind address (loopback in P1/P2; P3 opens it to the LAN). */
  listenHost: string
  /** Bind port; `0` asks the OS for a free port. */
  listenPort: number
  /** How many consecutive ports to try when the configured one is taken. */
  portProbeAttempts?: number
  /** Loopback origin to forward to. */
  upstreamOrigin: string
  /** Owns the injected loopback cookie. */
  auth: UpstreamAuth
  /**
   * The visitor gate. When present it runs BEFORE anything is forwarded, on
   * both the HTTP and the upgrade path: the gate is never behind the listener.
   */
  gate?: VisitorGate
  /** PEM certificate and key; when present the listener serves HTTPS. */
  tls?: { cert: string; key: string }
  /** Logger. */
  logger?: LanGuardLogger
}

/** A running proxy listener. */
export interface RunningProxy {
  /** The address actually bound. */
  readonly host: string
  /** The port actually bound (resolved when `listenPort` was 0). */
  readonly port: number
  /** The port that was configured (differs from `port` after a fallback). */
  readonly requestedPort: number
  /** Whether the configured port was taken and a later one was used instead. */
  readonly portFallback: boolean
  /** Stop listening and drop every live connection. */
  close(): Promise<void>
}

/** Bind one port, resolving on `listening` and rejecting on `error`. */
function listenOnce(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** Resolve an origin URL into the hostname/port pair `http.request` needs. */
export function parseUpstream(origin: string): UpstreamTarget {
  const url = new URL(origin)
  return {
    hostname: url.hostname,
    port: url.port === '' ? 80 : Number(url.port),
  }
}

/** Whether a request method may be retried after a `401` without side effects. */
function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

/**
 * Start the proxy listener.
 *
 * @param options - bind address, upstream origin and the cookie owner.
 * @returns the running proxy, resolved once the socket is bound.
 */
export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const logger = options.logger ?? noopLogger
  const upstream = parseUpstream(options.upstreamOrigin)
  const authority = authorityOf(options.upstreamOrigin)
  const sockets = new Set<Duplex>()

  const fail = (res: ServerResponse, code: number, body: string): void => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(`${body}\n`)
  }

  const forwardHttp = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    mayRetry: boolean,
  ): Promise<void> => {
    let cookie: string
    try {
      cookie = await options.auth.cookieHeader()
    } catch (error) {
      logger.warn('upstream authentication failed name=%s', (error as Error).name)
      fail(res, 502, 'dsh-lan-guard: upstream authentication unavailable')
      return
    }

    const headers = buildUpstreamRequestHeaders({
      headers: req.headers,
      authority,
      upstreamCookie: cookie,
    })
    const upstreamReq = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: target,
      headers,
    })

    upstreamReq.on('response', (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      if (status === 401 && mayRetry && isSafeMethod(req.method)) {
        upstreamRes.resume()
        options.auth.invalidate('upstream returned 401')
        void forwardHttp(req, res, target, false)
        return
      }
      res.writeHead(
        status,
        upstreamRes.statusMessage === '' ? undefined : upstreamRes.statusMessage,
        buildUpstreamResponseHeaders(upstreamRes.headers),
      )
      upstreamRes.pipe(res)
    })

    upstreamReq.on('error', (error: Error) => {
      logger.warn('upstream request failed name=%s code=%s', error.name, (error as NodeJS.ErrnoException).code ?? 'none')
      fail(res, 502, 'dsh-lan-guard: upstream unavailable')
    })

    res.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    })

    // A safe method has no body, and re-piping an already-consumed request
    // stream on the 401 retry would never emit `end` again.
    if (isSafeMethod(req.method)) upstreamReq.end()
    else req.pipe(upstreamReq)
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // The gate runs first and owns the response when it refuses.
      if (options.gate !== undefined) {
        // A rejection here would be an unhandled rejection, and Node 24 exits
        // the process on those — one bad request must never take dsh down.
        const decision = await options.gate.handleHttp(req, res).catch((error: Error) => {
          logger.warn('gate failed name=%s', error.name)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"ok":false,"error":"internal_error"}')
          } else {
            res.end()
          }
          return 'handled' as const
        })
        if (decision === 'handled') return
      }
      await forwardHttp(req, res, normalizeRequestTarget(req.url), true)
    })()
  }

  const server: Server = options.tls === undefined
    ? createServer(handler)
    : createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler) as unknown as Server

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // The error handler goes on BEFORE any await: a reconnect that drops the
    // socket mid-authentication must not emit an unhandled error.
    guardUpgradeSocket(socket, logger)
    void (async () => {
      // A WebSocket upgrade is a request like any other and passes the gate
      // first; an unauthenticated upgrade is refused before any upstream work.
      if (options.gate !== undefined) {
        const refusal = await options.gate.verifyUpgrade(req)
        if (refusal !== undefined) {
          if (!socket.destroyed) {
            socket.write(`HTTP/1.1 ${String(refusal.status)} Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
          }
          socket.destroy()
          return
        }
      }
      let cookie: string
      try {
        cookie = await options.auth.cookieHeader()
      } catch (error) {
        logger.warn('upgrade authentication failed name=%s', (error as Error).name)
        socket.destroy()
        return
      }
      forwardUpgrade({
        req,
        socket,
        head,
        upstream,
        target: normalizeRequestTarget(req.url),
        headers: buildUpstreamRequestHeaders({
          headers: req.headers,
          authority,
          upstreamCookie: cookie,
          upgrade: true,
        }),
        logger,
      })
    })()
  })

  // The configured port is a preference, not a promise: if it is taken, walk
  // up to the next free one instead of failing to start (user request
  // 2026-09-24: "3081, 3082, 3083 … take the first free one"). The real bind IS
  // the probe — no throwaway socket, so no race and no extra listener.
  const attempts = options.portProbeAttempts ?? 0
  const requestedPort = options.listenPort
  let boundPort = requestedPort
  for (let offset = 0; ; offset += 1) {
    try {
      await listenOnce(server, options.listenHost, boundPort)
      break
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (!busy || requestedPort === 0 || offset >= attempts) throw error
      const next = requestedPort + offset + 1
      logger.warn('port %d is taken; trying %d', boundPort, next)
      boundPort = next
    }
  }

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.listenPort

  return {
    host: options.listenHost,
    port,
    requestedPort,
    portFallback: port !== requestedPort,
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      })
    },
  }
}
