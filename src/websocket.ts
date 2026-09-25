/**
 * dsh-lan-guard — WebSocket upgrade forwarding.
 *
 * DSH serves its Remote stream on `/api/remote.mux` over a WebSocket upgrade, and the shipped UI keeps that socket open for the
 * whole session. The proxy therefore has to relay the upgrade itself rather
 * than treat it as an ordinary HTTP response.
 *
 * Two rules from the researched reference implementations are applied here:
 *
 * - The visitor's socket gets an `error` handler IMMEDIATELY, before any
 *   asynchronous work. A phone reconnecting drops
 *   upgrade sockets constantly; an unhandled `error` during an await would
 *   take the whole process down. This is also why the gate in P2 can await
 *   safely.
 * - The upstream 101 passes only the handshake headers a browser needs— never the upstream's arbitrary header set.
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import type { Duplex } from 'node:stream'
import { buildUpgradeResponseHead } from './headers.ts'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'

/** Where an upstream request goes. */
export interface UpstreamTarget {
  /** Upstream hostname (a loopback literal in this project). */
  hostname: string
  /** Upstream port. */
  port: number
}

/** Attach the mandatory `error` handler to a socket we now own. */
export function guardUpgradeSocket(socket: Duplex, logger: LanGuardLogger = noopLogger): void {
  socket.on('error', (error: Error) => {
    // A phone that walks out of Wi-Fi range produces ECONNRESET/EPIPE here; it
    // is routine, not an incident, and must never surface as an unhandled error.
    logger.debug?.('upgrade socket error name=%s', error.name)
    socket.destroy()
  })
}

/** Options for {@link forwardUpgrade}. */
export interface UpgradeForwardOptions {
  /** The visitor's upgrade request. */
  req: IncomingMessage
  /** The visitor's socket. */
  socket: Duplex
  /** Bytes the HTTP parser already read past the request head. */
  head: Buffer
  /** Upstream destination. */
  upstream: UpstreamTarget
  /** Already-rewritten request headers (host/origin/cookie). */
  headers: OutgoingHttpHeaders
  /** Normalized upstream request target. */
  target: string
  /** Logger. */
  logger?: LanGuardLogger
}

/**
 * Relay one WebSocket upgrade to the upstream and pipe both directions.
 *
 * @param options - the upgrade request, its socket, and the prepared headers.
 * @returns a handle whose `destroy()` tears the tunnel down.
 */
export function forwardUpgrade(options: UpgradeForwardOptions): { destroy(): void } {
  const { req, socket, head, upstream, headers, target } = options
  const logger = options.logger ?? noopLogger
  guardUpgradeSocket(socket, logger)

  const upstreamReq = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method ?? 'GET',
    path: target,
    headers,
  })

  let upstreamSocket: Duplex | undefined

  upstreamReq.on('upgrade', (upstreamRes, upstreamDuplex, upstreamHead) => {
    upstreamSocket = upstreamDuplex
    guardUpgradeSocket(upstreamDuplex, logger)
    upstreamDuplex.on('close', () => socket.destroy())
    socket.on('close', () => upstreamDuplex.destroy())

    socket.write(buildUpgradeResponseHead(
      upstreamRes.headers,
      upstreamRes.statusCode ?? 101,
      upstreamRes.statusMessage === '' ? 'Switching Protocols' : upstreamRes.statusMessage ?? 'Switching Protocols',
    ))
    if (upstreamHead.length > 0) socket.write(upstreamHead)

    upstreamDuplex.pipe(socket)
    socket.pipe(upstreamDuplex)
  })

  upstreamReq.on('response', (upstreamRes) => {
    // The upstream answered with a normal HTTP response instead of upgrading
    // (for example a 401 from the fence). Relay the status and close: there is
    // no tunnel to keep.
    logger.debug?.('upgrade refused by upstream status=%d', upstreamRes.statusCode ?? 0)
    upstreamRes.resume()
    if (!socket.destroyed) {
      const status = upstreamRes.statusCode ?? 502
      const message = upstreamRes.statusMessage === '' ? 'Upstream Refused' : upstreamRes.statusMessage ?? 'Upstream Refused'
      socket.write(`HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    }
    socket.destroy()
  })

  upstreamReq.on('error', (error: Error) => {
    logger.warn('upgrade upstream error name=%s', error.name)
    socket.destroy()
  })

  if (head.length > 0) upstreamReq.write(head)
  upstreamReq.end()

  return {
    destroy() {
      upstreamReq.destroy()
      upstreamSocket?.destroy()
      socket.destroy()
    },
  }
}
