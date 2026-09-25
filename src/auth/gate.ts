/**
 * dsh-lan-guard — the visitor-facing request gate (docs/SPEC.md F3).
 *
 * This is the only code path between a LAN client and DSH's own UI, so it
 * owns four decisions and nothing else:
 *
 * 1. gate-owned paths (`/__dsh_lan_guard__/*`) never reach the upstream;
 * 2. a passwordless link (`?auth=<secretToken>`) is exchanged for a session
 *    cookie and answered with a `302` to the CLEAN url — the same shape as
 *    DSH's own token exchange (docs/RESEARCH.md §3.3). The parameter name is
 *    `auth`, never `token`: `token` is DSH's launch token and must be
 *    forwarded upstream untouched (docs/SPEC.md F7);
 * 3. an unauthorized HTML navigation gets the login page, while `/api/*` and
 *    non-HTML requests get `401` JSON — never a login page a fetch would
 *    silently parse;
 * 4. every state-changing request passes the CSRF check first.
 *
 * It deliberately does NOT decide policy: that lives in the auth manager.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'
import type { AuthManager, VerifyResult } from './manager.ts'
import type { DeviceRegistry } from '../store/devices.ts'
import {
  buildSessionCookie,
  clientIp,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_MS,
  passesCsrfCheck,
  readCookie,
} from './manager.ts'
import { renderLoginPage, renderPairingPage, type LoginState } from './login-page.ts'

/** Path prefix the gate owns on the proxy origin. */
export const GATE_PREFIX = '/__dsh_lan_guard__'
/** The login form's action path. */
export const LOGIN_PATH = `${GATE_PREFIX}/login`
/** The device-pairing form's action path. */
export const PAIR_PATH = `${GATE_PREFIX}/pair`
/** Largest accepted login body. */
const MAX_LOGIN_BODY_BYTES = 4 * 1024

/** Options for {@link VisitorGate}. */
export interface VisitorGateOptions {
  auth: AuthManager
  /** Paired devices (P4-g): each has its own revocable identity. */
  devices?: DeviceRegistry | undefined
  /** Whether an unnamed device must pair first (live switch). */
  requirePairing?: (() => boolean) | undefined
  /** Whether a paired device also needs the operator's approval (F9). */
  requireApproval?: (() => boolean) | undefined
  logger?: LanGuardLogger
}

/** What the gate decided about a request. */
export type GateDecision = 'handled' | 'allow'

/** Guess a friendly device name from the User-Agent, as a pairing default. */
export function guessDeviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  if (/iPhone/i.test(ua)) return '我的 iPhone'
  if (/iPad/i.test(ua)) return '我的 iPad'
  if (/Android/i.test(ua)) return '我的 Android 设备'
  if (/Macintosh|Mac OS X/i.test(ua)) return '我的 Mac'
  if (/Windows/i.test(ua)) return '我的 Windows 电脑'
  if (/Linux/i.test(ua)) return '我的 Linux 设备'
  return '我的设备'
}

/** Whether a request accepts an HTML document. */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

/** Whether a path belongs to the `/api` surface. */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/** Validate a post-login redirect target: a local absolute path only. */
export function safeNextPath(candidate: string | null | undefined): string {
  if (candidate === null || candidate === undefined) return '/'
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/'
  return candidate
}

/** The visitor gate. */
export class VisitorGate {
  readonly #auth: AuthManager
  readonly #devices: DeviceRegistry | undefined
  readonly #requirePairing: () => boolean
  readonly #requireApproval: () => boolean
  readonly #logger: LanGuardLogger

  constructor(options: VisitorGateOptions) {
    this.#auth = options.auth
    this.#devices = options.devices
    this.#requirePairing = options.requirePairing ?? (() => false)
    this.#requireApproval = options.requireApproval ?? (() => false)
    this.#logger = options.logger ?? noopLogger
  }

  /**
   * Handle one HTTP request.
   *
   * @param req - the visitor's request.
   * @param res - the response, owned when the gate returns `'handled'`.
   * @returns `'allow'` when the caller may forward the request upstream.
   */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<GateDecision> {
    const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')

    if (url.pathname === LOGIN_PATH) {
      if (req.method === 'POST') {
        await this.#handleLogin(req, res)
        return 'handled'
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        this.#sendLoginPage(req, res, 'prompt', 200)
        return 'handled'
      }
      this.#sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return 'handled'
    }

    if (url.pathname === PAIR_PATH) {
      if (req.method === 'POST') {
        await this.#handlePair(req, res)
        return 'handled'
      }
      this.#sendPairingPage(req, res)
      return 'handled'
    }

    if (url.pathname.startsWith(`${GATE_PREFIX}/`)) {
      this.#sendJson(res, 404, { ok: false, error: 'not_found' })
      return 'handled'
    }

    // A device identity is the durable credential: once paired, a device is
    // recognised by its own cookie, and revoking the record cuts it off here.
    const deviceToken = readCookie(req, DEVICE_COOKIE)
    if (deviceToken !== undefined) {
      const device = this.#devices?.lookup(deviceToken)
      if (device === undefined || device.revokedAtMs !== null || device.status === 'blocked') {
        this.#logger.warn('refused a revoked, blocked or unknown device ip=%s', clientIp(req))
        this.#sendRemoved(req, res)
        return 'handled'
      }
      if (device.status === 'pending') {
        // Paired but not yet approved (F9): show the waiting page instead.
        this.#sendPending(req, res)
        return 'handled'
      }
      // Bookkeeping only: a failed write must never refuse or crash a request.
      await this.#devices?.touch(device.id, clientIp(req)).catch((error: Error) => {
        this.#logger.warn('device touch failed name=%s', error.name)
      })
      return 'allow'
    }

    const link = url.searchParams.get('auth')
    if (link !== null) {
      // A link this mode ignores (or a bad link) may still be an authenticated
      // request: only a completed response counts as handled.
      return await this.#handleAuthLink(req, res, url, link)
    }

    const verdict = await this.#auth.verifyRequest(req)
    if (verdict.ok) {
      // Pairing exists to name REMOTE devices; the machine's own operator
      // (loopback) and a disabled gate never see it.
      if (this.#requirePairing() && verdict.via === 'session') {
        this.#sendPairingPage(req, res)
        return 'handled'
      }
      return 'allow'
    }
    this.#sendUnauthorized(req, res, verdict)
    return 'handled'
  }

  /**
   * Decide whether an upgrade may proceed.
   *
   * The caller must have attached its socket error handler BEFORE awaiting
   * this (docs/RESEARCH.md §5.7 ①).
   *
   * @param req - the upgrade request.
   * @returns `undefined` when the upgrade may proceed, else the status to send.
   */
  async verifyUpgrade(req: IncomingMessage): Promise<{ status: number; reason: string } | undefined> {
    const deviceToken = readCookie(req, DEVICE_COOKIE)
    if (deviceToken !== undefined) {
      const device = this.#devices?.lookup(deviceToken)
      if (device === undefined || device.revokedAtMs !== null || device.status === 'blocked') {
        this.#logger.warn('upgrade refused: revoked or blocked device ip=%s', clientIp(req))
        return { status: 403, reason: 'device_revoked' }
      }
      if (device.status === 'pending') return { status: 403, reason: 'pending_approval' }
      await this.#devices?.touch(device.id, clientIp(req)).catch(() => undefined)
      return undefined
    }
    const verdict = await this.#auth.verifyRequest(req)
    if (!verdict.ok) {
      this.#logger.warn('upgrade refused reason=%s ip=%s', verdict.reason, clientIp(req))
      return { status: 401, reason: verdict.reason }
    }
    if (this.#requirePairing() && verdict.via === 'session') {
      return { status: 403, reason: 'pairing_required' }
    }
    return undefined
  }

  /** Create the device identity for a request that already passed the gate. */
  async #handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#devices === undefined) {
      this.#sendJson(res, 503, { ok: false, error: 'pairing_unavailable' })
      return
    }
    if (!passesCsrfCheck(req)) {
      this.#sendPairingPage(req, res, 'csrf')
      return
    }
    const verdict = await this.#auth.verifyRequest(req)
    if (!verdict.ok) {
      this.#sendUnauthorized(req, res, verdict)
      return
    }
    const body = await readBody(req)
    const label = new URLSearchParams(body ?? '').get('label') ?? ''
    if (label.trim() === '') {
      this.#sendPairingPage(req, res, 'invalid')
      return
    }
    // F9: with approval required the device starts pending and sees the waiting
    // page until the operator approves it in the settings page.
    const { device, token } = await this.#devices.add(label, { pending: this.#requireApproval() })
    await this.#devices.touch(device.id, clientIp(req)).catch(() => undefined)
    const expiresAtMs = Date.now() + DEVICE_COOKIE_MAX_AGE_MS
    res.writeHead(302, {
      location: '/',
      'set-cookie': buildSessionCookie(DEVICE_COOKIE, token, expiresAtMs, Date.now()),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  /** Serve the pairing page (HTML) or a JSON hint for API calls. */
  #sendPairingPage(req: IncomingMessage, res: ServerResponse, error?: 'invalid' | 'csrf'): void {
    const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
    if (isApiPath(url.pathname) || !wantsHtml(req)) {
      this.#sendJson(res, 428, { ok: false, error: 'pairing_required' })
      return
    }
    const html = renderPairingPage({
      defaultLabel: guessDeviceLabel(req.headers['user-agent']),
      ip: clientIp(req),
      ...(error === undefined ? {} : { error }),
    })
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end(html)
  }

  /** Serve the waiting page (HTML) or a JSON hint for API calls (F9). */
  #sendPending(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
    if (isApiPath(url.pathname) || !wantsHtml(req)) {
      this.#sendJson(res, 403, { ok: false, error: 'pending_approval' })
      return
    }
    const html = renderLoginPage({ state: 'pending-approval', mode: this.#auth.mode })
    res.writeHead(403, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(html)
  }

  /** Tell a revoked device it no longer has access. */
  #sendRemoved(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
    if (isApiPath(url.pathname) || !wantsHtml(req)) {
      this.#sendJson(res, 403, { ok: false, error: 'device_revoked' })
      return
    }
    const html = renderLoginPage({
      state: 'device-removed',
      mode: this.#auth.mode,
    })
    res.writeHead(403, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(html)
  }

  /** Exchange a passwordless link for a session, then redirect to the clean URL. */
  async #handleAuthLink(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    link: string,
  ): Promise<GateDecision> {
    if (this.#auth.mode === 'password') {
      // Password-only mode ignores the parameter; the request still has to pass
      // the ordinary verdict (and is forwarded unchanged when it does).
      const verdict = await this.#auth.verifyRequest(req)
      if (verdict.ok) return 'allow'
      this.#sendUnauthorized(req, res, verdict)
      return 'handled'
    }
    // Two kinds of link reach here: the master passwordless token, and a
    // paired device's own token (revocable one by one).
    const masterAccepted = await this.#auth.verifySecretToken(link)
    const device = masterAccepted ? undefined : this.#devices?.verify(link)
    const accepted = masterAccepted || device !== undefined
    if (!accepted) {
      this.#logger.warn('passwordless link rejected ip=%s', clientIp(req))
      const verdict = await this.#auth.verifyRequest(req)
      if (verdict.ok) return 'allow'
      this.#sendUnauthorized(req, res, verdict)
      return 'handled'
    }
    const session = await this.#auth.issueSession()
    if (device !== undefined) {
      // Record which device used its link (never the token itself).
      await this.#devices?.touch(device.id, clientIp(req))
    }
    const clean = new URL(url.toString())
    clean.searchParams.delete('auth')
    res.writeHead(302, {
      location: `${clean.pathname}${clean.search}`,
      'set-cookie': session.cookie,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
    return 'handled'
  }

  /** Handle the login form submission. */
  async #handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!passesCsrfCheck(req)) {
      // Keep the observed values in the LOG only (the page stays clean): a CSRF
      // refusal on a real phone is otherwise a dead end.
      this.#logger.warn(
        'login refused by csrf check sec-fetch-site=%s origin=%s host=%s',
        req.headers['sec-fetch-site'] ?? '(none)',
        req.headers.origin ?? '(none)',
        req.headers.host ?? '(none)',
      )
      this.#sendLoginPage(req, res, 'csrf', 403)
      return
    }
    if (this.#auth.mode === 'token') {
      this.#sendLoginPage(req, res, 'token-only', 403)
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      this.#sendJson(res, 413, { ok: false, error: 'body_too_large' })
      return
    }
    const form = new URLSearchParams(body)
    const password = form.get('password') ?? ''
    const next = safeNextPath(form.get('next'))
    const result = await this.#auth.login(req, password)
    if (result.ok) {
      res.writeHead(302, {
        location: next,
        'set-cookie': result.cookie,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }
    if (result.reason === 'locked') {
      this.#sendLoginPage(req, res, 'locked', 429, result.lockedUntilMs)
      return
    }
    if (result.reason === 'no-password') {
      this.#sendLoginPage(req, res, 'no-password', 403)
      return
    }
    this.#sendLoginPage(req, res, 'invalid', 401)
  }

  /** Answer a refused request with the login page or a JSON error. */
  #sendUnauthorized(req: IncomingMessage, res: ServerResponse, verdict: VerifyResult): void {
    const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
    const lockedUntilMs = verdict.ok ? undefined : verdict.lockedUntilMs
    if (verdict.ok || verdict.reason !== 'locked') {
      this.#logger.info('request refused reason=%s ip=%s', verdict.ok ? 'ok' : verdict.reason, clientIp(req))
    }
    if (!this.#auth.hasPassword) {
      if (wantsHtml(req)) {
        this.#sendLoginPage(req, res, 'no-password', 403)
        return
      }
      this.#sendJson(res, 403, { ok: false, error: 'no_password_configured' })
      return
    }
    if (verdict.ok === false && verdict.reason === 'locked') {
      if (wantsHtml(req)) {
        this.#sendLoginPage(req, res, 'locked', 429, lockedUntilMs)
        return
      }
      this.#sendJson(res, 429, { ok: false, error: 'locked', lockedUntilMs: lockedUntilMs ?? 0 })
      return
    }
    if (isApiPath(url.pathname) || !wantsHtml(req)) {
      this.#sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const next = safeNextPath(`${url.pathname}${url.search}`)
    this.#sendLoginPage(req, res, 'prompt', 401, undefined, next)
  }

  /** Write the login page. */
  #sendLoginPage(
    req: IncomingMessage,
    res: ServerResponse,
    state: LoginState,
    status: number,
    lockedUntilMs?: number,
    next?: string,
  ): void {
    const html = renderLoginPage({
      state,
      mode: this.#auth.mode,
      ...(lockedUntilMs === undefined ? {} : { lockedUntilMs }),
      ...(next === undefined ? {} : { next }),
    })
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : html)
  }

  /** Write a JSON error. */
  #sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(`${JSON.stringify(body)}\n`)
  }
}

/** Read a small request body, or `undefined` when it exceeds the limit. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_LOGIN_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
