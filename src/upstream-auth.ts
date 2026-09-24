/**
 * dsh-lan-guard — upstream loopback authentication (SPEC §3 F2, route A).
 *
 * The browser holds a cookie for the PROXY origin; DSH's fence authenticates a
 * cookie bound to the authority `127.0.0.1:<dshPort>` (docs/RESEARCH.md §3.4).
 * So the proxy cannot reuse the visitor's cookie and must hold one of its own.
 *
 * Route A (the decided route) uses only the public seam
 * `ctx.connection.authenticatedUrl(origin)`:
 *
 *   GET /?token=<launch token>  →  303 + Set-Cookie + Location: ./
 *
 * and caches the resulting cookie. The launch token is process-scoped, so a
 * DSH restart invalidates it — this class detects that by re-reading the
 * token through the seam on every call and re-exchanging when it changes.
 *
 * Route B (reading the credentials file and signing a cookie ourselves) is
 * deliberately NOT implemented: it would depend on DSH's private format and
 * fail silently with a 401 after any format change.
 *
 * The launch token and the session cookie are credentials: they are held in
 * memory only, never logged, never written to disk (docs/GUARDRAILS.md §4).
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'

/** How long to wait for the token→cookie exchange before giving up. */
const EXCHANGE_TIMEOUT_MS = 5_000
/** Re-exchange this long before the cookie expires, so a request never races expiry. */
const REFRESH_SKEW_MS = 60_000
/** Fallback cookie lifetime when the upstream sends neither Max-Age nor Expires. */
const FALLBACK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

/** Raised when the upstream refuses to mint a loopback session. */
export class UpstreamAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamAuthError'
  }
}

/** The cached upstream session. */
export interface UpstreamSession {
  /** The exact `name=value` pair to inject as the upstream `cookie` header. */
  cookie: string
  /** Cookie name, safe to log (a hash of the authority, never the value). */
  cookieName: string
  /** Absolute expiry, in epoch milliseconds. */
  expiresAtMs: number
  /** The process launch token this session was minted from. */
  launchToken: string
}

/** What one exchange request observed. */
interface ExchangeResponse {
  statusCode: number
  statusMessage: string
  headers: IncomingHttpHeaders
}

/** Parse the `Max-Age`/`Expires` attributes of one `Set-Cookie` value. */
function cookieExpiry(value: string, now: number): number {
  const attributes = value.split(';').slice(1)
  for (const attribute of attributes) {
    const at = attribute.indexOf('=')
    if (at === -1) continue
    const name = attribute.slice(0, at).trim().toLowerCase()
    const raw = attribute.slice(at + 1).trim()
    if (name === 'max-age') {
      const seconds = Number.parseInt(raw, 10)
      if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1_000
    }
    if (name === 'expires') {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed) && parsed > now) return parsed
    }
  }
  return now + FALLBACK_MAX_AGE_MS
}

/** Extract the `name=value` pair from the first `Set-Cookie` header. */
function firstCookiePair(setCookie: string | string[] | undefined): string | undefined {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (typeof first !== 'string') return undefined
  const pair = first.split(';')[0]?.trim() ?? ''
  const at = pair.indexOf('=')
  if (at <= 0) return undefined
  return pair
}

/** Perform one exchange request without following redirects (the 303 carries the cookie). */
function exchangeRequest(url: URL): Promise<ExchangeResponse> {
  return new Promise<ExchangeResponse>((resolve, reject) => {
    const req = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? undefined : Number(url.port),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        accept: 'text/html,application/xhtml+xml',
        'cache-control': 'no-store',
      },
    }, (res) => {
      const response: ExchangeResponse = {
        statusCode: res.statusCode ?? 0,
        statusMessage: res.statusMessage ?? '',
        headers: res.headers,
      }
      // Headers are complete here; drain and drop the tiny redirect body.
      res.resume()
      resolve(response)
    })
    req.setTimeout(EXCHANGE_TIMEOUT_MS, () => {
      req.destroy(new UpstreamAuthError('dsh-lan-guard: upstream token exchange timed out'))
    })
    req.on('error', (error: Error) => {
      reject(error instanceof UpstreamAuthError
        ? error
        : new UpstreamAuthError(`dsh-lan-guard: upstream token exchange failed: ${error.message}`))
    })
    req.end()
  })
}

/** Options for {@link UpstreamAuth}. */
export interface UpstreamAuthOptions {
  /** The loopback origin to authenticate against, e.g. `http://127.0.0.1:3080`. */
  origin: string
  /** The `ctx.connection.authenticatedUrl` seam. */
  authenticatedUrl: (baseUrl: string) => string
  /** Clock injection for tests. */
  now?: () => number
  /** Logger; credentials are never passed to it. */
  logger?: LanGuardLogger
}

/**
 * Owns the proxy's loopback session cookie: acquisition, caching and renewal.
 */
export class UpstreamAuth {
  readonly #origin: string
  readonly #authenticatedUrl: (baseUrl: string) => string
  readonly #now: () => number
  readonly #logger: LanGuardLogger
  #session: UpstreamSession | undefined
  #inflight: Promise<UpstreamSession> | undefined

  constructor(options: UpstreamAuthOptions) {
    this.#origin = options.origin
    this.#authenticatedUrl = options.authenticatedUrl
    this.#now = options.now ?? (() => Date.now())
    this.#logger = options.logger ?? noopLogger
  }

  /** The launch token currently offered by the seam. Never logged. */
  #currentToken(): string {
    const url = new URL(this.#authenticatedUrl(this.#origin))
    const token = url.searchParams.get('token')
    if (token === null || token === '') {
      throw new UpstreamAuthError(
        'dsh-lan-guard: ctx.connection.authenticatedUrl() returned no launch token; '
        + 'the upstream authentication seam changed (see docs/RESEARCH.md §3.3)',
      )
    }
    return token
  }

  /** Whether the cached session still matches the live token and has not neared expiry. */
  #isFresh(session: UpstreamSession, token: string): boolean {
    return session.launchToken === token && this.#now() < session.expiresAtMs - REFRESH_SKEW_MS
  }

  /**
   * Return the `name=value` pair to inject upstream, exchanging when needed.
   *
   * @returns the cookie pair.
   * @throws UpstreamAuthError when no session could be established.
   */
  async cookieHeader(): Promise<string> {
    const token = this.#currentToken()
    const cached = this.#session
    if (cached !== undefined && this.#isFresh(cached, token)) return cached.cookie
    if (this.#inflight === undefined) {
      this.#inflight = this.#exchange(token).finally(() => {
        this.#inflight = undefined
      })
    }
    const session = await this.#inflight
    return session.cookie
  }

  /**
   * Drop the cached session so the next call re-exchanges.
   *
   * @param reason - short, non-secret reason for the log line.
   */
  invalidate(reason: string): void {
    if (this.#session === undefined) return
    this.#session = undefined
    this.#logger.warn('upstream session invalidated reason=%s', reason)
  }

  /** Perform one token→cookie exchange. */
  async #exchange(token: string): Promise<UpstreamSession> {
    const url = new URL(this.#authenticatedUrl(this.#origin))
    const response = await exchangeRequest(url)
    if (response.statusCode !== 303) {
      throw new UpstreamAuthError(
        `dsh-lan-guard: upstream token exchange expected 303, received ${response.statusCode}`,
      )
    }
    const pair = firstCookiePair(response.headers['set-cookie'])
    if (pair === undefined) {
      throw new UpstreamAuthError('dsh-lan-guard: upstream token exchange returned no session cookie')
    }
    const location = response.headers.location
    if (location !== './') {
      this.#logger.warn('upstream token exchange returned unexpected location=%s', String(location))
    }
    const cookieName = pair.slice(0, pair.indexOf('='))
    const expiresAtMs = cookieExpiry(
      Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] ?? '' : response.headers['set-cookie'] ?? '',
      this.#now(),
    )
    const session: UpstreamSession = { cookie: pair, cookieName, expiresAtMs, launchToken: token }
    this.#session = session
    // Only the cookie NAME is logged: it is a hash of the authority, not a credential.
    this.#logger.info(
      'upstream session established cookie=%s expiresInMs=%d',
      cookieName,
      expiresAtMs - this.#now(),
    )
    return session
  }
}
