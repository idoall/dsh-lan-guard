/**
 * dsh-lan-guard — header translation for the reverse proxy.
 *
 * Two invariants drive everything here (docs/SPEC.md F1/F2, §6.6):
 *
 * 1. The upstream sees a request that came from its own loopback origin, so
 *    `host` (and `origin`, when the browser sent one) are rewritten to the
 *    upstream authority and a loopback session cookie is injected. The DSH
 *    Host/Origin fence keys the cookie to that exact authority
 *    (docs/RESEARCH.md §3.2), so the rewritten `host` and the cookie must
 *    always agree.
 * 2. The upstream response is NOT trusted verbatim: hop-by-hop headers never
 *    cross a proxy hop, `set-cookie` is not relayed to the browser (the proxy
 *    injects the upstream cookie itself), and a WebSocket 101 passes only the
 *    handshake headers the browser needs.
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

/** Hop-by-hop headers that must not be forwarded in either direction (RFC 9110 §7.6.1). */
export const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const

/**
 * Headers a WebSocket 101 may carry upstream → browser. Everything else the
 * upstream sends is dropped (docs/RESEARCH.md §5.3).
 */
export const UPGRADE_RESPONSE_HEADERS = [
  'connection',
  'upgrade',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
] as const

/**
 * Header the proxy stamps on every request it forwards upstream.
 *
 * The proxy rewrites `host` to loopback, so DSH's own web server cannot tell a
 * request that came from this machine from one that came in over the LAN. The
 * management surface needs that distinction — "127.0.0.1 has physical
 * unlock privilege, remote access must be locked" (user decision 2026-09-24) —
 * so the proxy marks what it forwards. The incoming copy is DELETED first, so a
 * visitor cannot forge the marker on a direct request.
 */
export const VISITOR_HEADER = 'x-dsh-lan-guard-visitor'

/** Request headers the proxy always replaces, never forwards verbatim. */
const REPLACED_REQUEST_HEADERS = ['host', 'origin', 'cookie', VISITOR_HEADER] as const

/** Response headers dropped on top of the hop-by-hop set. */
const DROPPED_RESPONSE_HEADERS = ['set-cookie'] as const

/** Whether a request target is a WebSocket upgrade rather than a plain HTTP request. */
export function isUpgradeRequest(headers: IncomingHttpHeaders): boolean {
  const connection = headers.connection
  const upgrade = headers.upgrade
  const tokens = typeof connection === 'string' ? connection.toLowerCase().split(',').map(part => part.trim()) : []
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket' && tokens.includes('upgrade')
}

/**
 * The `host:port` authority of an origin URL — the value the upstream fence
 * binds cookies to.
 *
 * @param origin - an absolute http(s) origin.
 * @returns the authority, e.g. `127.0.0.1:3080`.
 * @throws when the origin cannot be parsed.
 */
export function authorityOf(origin: string): string {
  const url = new URL(origin)
  return url.host
}

/**
 * Normalize a request target before forwarding.
 *
 * Node hands us the raw request target. A bare-origin request already arrives
 * as `/`, but an absolute-form target (or a target with no path at all) must
 * still land on `/`, because the shipped shell carries `<base href="./">` and
 * resolves every relative asset against the directory it was served from
 * (docs/RESEARCH.md §7.1). We mount at the root only, so no prefix is ever
 * stripped and no target is rewritten beyond this normalization.
 *
 * @param rawTarget - `req.url` as received.
 * @returns a root-relative path plus its exact query string.
 */
export function normalizeRequestTarget(rawTarget: string | undefined): string {
  if (rawTarget === undefined || rawTarget === '') return '/'
  if (rawTarget === '*') return '*'
  if (rawTarget.startsWith('/')) return rawTarget
  if (rawTarget.startsWith('?')) return `/${rawTarget}`
  try {
    const url = new URL(rawTarget)
    return `${url.pathname === '' ? '/' : url.pathname}${url.search}`
  } catch {
    return rawTarget.startsWith('?') ? `/${rawTarget}` : `/${rawTarget}`
  }
}

/**
 * Build the header set sent upstream.
 *
 * @param input.headers - the visitor's request headers.
 * @param input.authority - upstream `host:port`.
 * @param input.upstreamCookie - the loopback session cookie to inject, if known.
 * @param input.upgrade - true for a WebSocket upgrade (keeps `connection`/`upgrade`).
 * @returns headers safe to hand to `http.request`.
 */
export function buildUpstreamRequestHeaders(input: {
  headers: IncomingHttpHeaders
  authority: string
  upstreamCookie?: string | undefined
  upgrade?: boolean
}): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {}
  const hopByHop = new Set<string>(HOP_BY_HOP_HEADERS)
  const replaced = new Set<string>(REPLACED_REQUEST_HEADERS)

  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (replaced.has(lower)) continue
    // A WebSocket upgrade legitimately carries `connection`/`upgrade`; a plain
    // request never does, and forwarding them would be a hop-by-hop violation.
    if (hopByHop.has(lower) && !input.upgrade) continue
    outgoing[lower] = value
  }

  // Always stamped, never inherited: this is the only reliable signal that a
  // request reached DSH through the LAN gateway.
  outgoing[VISITOR_HEADER] = '1'
  outgoing.host = input.authority
  const origin = input.headers.origin
  if (origin !== undefined) outgoing.origin = `http://${input.authority}`
  if (input.upstreamCookie !== undefined && input.upstreamCookie !== '') {
    // Replace, never append: the visitor's cookies belong to the proxy origin
    // (in P2 one of them is the gate session) and must not reach the upstream.
    outgoing.cookie = input.upstreamCookie
  }
  return outgoing
}

/**
 * Filter an upstream response's headers for the browser.
 *
 * @param headers - upstream response headers.
 * @returns headers safe to write to the visitor's response.
 */
export function buildUpstreamResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {}
  const dropped = new Set<string>([...HOP_BY_HOP_HEADERS, ...DROPPED_RESPONSE_HEADERS])
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (dropped.has(name.toLowerCase())) continue
    outgoing[name] = value
  }
  return outgoing
}

/**
 * Serialize the response head of a proxied WebSocket 101.
 *
 * Only {@link UPGRADE_RESPONSE_HEADERS} survive, so an upstream cannot inject
 * arbitrary headers into the upgraded stream.
 *
 * @param headers - upstream 101 response headers.
 * @param statusCode - upstream status code.
 * @param statusMessage - upstream status message.
 * @returns the raw head bytes to write to the visitor's socket.
 */
export function buildUpgradeResponseHead(
  headers: IncomingHttpHeaders,
  statusCode: number,
  statusMessage: string,
): string {
  const lines: string[] = [`HTTP/1.1 ${statusCode} ${statusMessage}`]
  const allowed = new Set<string>(UPGRADE_RESPONSE_HEADERS)
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (!allowed.has(lower)) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${lower}: ${item}`)
      continue
    }
    lines.push(`${lower}: ${value}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}
