/**
 * dsh-lan-guard — header translation for the reverse proxy.
 *
 * Two invariants drive everything here:
 *
 * 1. The upstream sees a request that came from its own loopback origin, so
 *    `host` (and `origin`, when the browser sent one) are rewritten to the
 *    upstream authority and a loopback session cookie is injected. The DSH
 *    Host/Origin fence keys the cookie to that exact authority, so the rewritten `host` and the cookie must
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
 * upstream sends is dropped.
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

/**
 * Read one `name=value` pair out of a `Cookie` request header.
 *
 * Deliberately not a cookie parser: the value is relayed byte-for-byte, and the
 * only decision here is which NAME to keep.
 *
 * @param header - the visitor's `cookie` header.
 * @param name - the cookie name to extract.
 * @returns the exact `name=value` pair, or `undefined`.
 */
export function cookiePairOf(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim() === name) return trimmed
  }
  return undefined
}

/** The cookie name of one `Set-Cookie` entry. */
function setCookieName(entry: string): string | undefined {
  const eq = entry.indexOf('=')
  if (eq <= 0) return undefined
  const name = entry.slice(0, eq).trim()
  return name === '' ? undefined : name
}

/** Normalize a header value that may be a single string or a list. */
function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

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
 * resolves every relative asset against the directory it was served from. We mount at the root only, so no prefix is ever
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
 * @param input.relayCookieNames - the plugin's OWN cookie names that must reach
 *   the upstream. DSH's session cookie is injected by the proxy, and the
 *   visitor's other cookies (the gate session and device identity) belong to the
 *   proxy origin and must never reach DSH — but this plugin mints an admin
 *   session cookie that DSH's web server has to SEE to honour, and the proxy is
 *   the only path that request takes. Relaying a name allowlist (rather than the
 *   whole header) keeps both properties.
 * @returns headers safe to hand to `http.request`.
 */
export function buildUpstreamRequestHeaders(input: {
  headers: IncomingHttpHeaders
  authority: string
  upstreamCookie?: string | undefined
  upgrade?: boolean
  relayCookieNames?: readonly string[]
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
    // Replace, never append wholesale: the visitor's cookies belong to the proxy
    // origin (the gate session and the device identity) and must not reach the
    // upstream. The named exceptions are this plugin's own credentials.
    const relayed = (input.relayCookieNames ?? [])
      .map(name => cookiePairOf(input.headers.cookie, name))
      .filter((pair): pair is string => pair !== undefined)
    outgoing.cookie = relayed.length === 0
      ? input.upstreamCookie
      : `${input.upstreamCookie}; ${relayed.join('; ')}`
  }
  return outgoing
}

/**
 * Filter an upstream response's headers for the browser.
 *
 * `set-cookie` stays dropped EXCEPT for the plugin's own cookie names (see
 * {@link buildUpstreamRequestHeaders}): DSH's own session cookie must never
 * reach a visitor, while this plugin's admin session has to be stored by the
 * visitor's browser or remote management could never unlock.
 *
 * @param headers - upstream response headers.
 * @param relayCookieNames - the plugin's own cookie names that may round-trip.
 * @returns headers safe to write to the visitor's response.
 */
export function buildUpstreamResponseHeaders(
  headers: IncomingHttpHeaders,
  relayCookieNames: readonly string[] = [],
): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {}
  const dropped = new Set<string>(HOP_BY_HOP_HEADERS)
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'set-cookie') {
      const kept = toArray(value).filter(entry => relayCookieNames.includes(setCookieName(entry) ?? ''))
      if (kept.length > 0) outgoing['set-cookie'] = kept
      continue
    }
    if (dropped.has(lower)) continue
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
