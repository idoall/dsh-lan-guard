/**
 * Gate integration tests (docs/PLAN.md §5 必须验证 · 门禁).
 *
 * These run the REAL proxy with the REAL gate in front of a fake upstream, and
 * drive it over HTTP and a raw WebSocket upgrade — the same paths a phone uses.
 * `allowLoopback: false` is deliberate: the suite connects from loopback, so
 * the gate must be exercised rather than bypassed.
 */
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startLanGuard, type LanGuardRuntime } from '../src/index.ts'
import type { LanGuardLogger } from '../src/log.ts'
import { startFakeDsh, type FakeDsh } from './helpers/fake-dsh.ts'
import { requestTo, type RawResponse } from './helpers/http-client.ts'
import { tmpDataDir } from './helpers/tmp.ts'

const PASSWORD = 'correct horse battery staple'

let fake: FakeDsh | undefined
let runtime: LanGuardRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  await fake?.close()
  runtime = undefined
  fake = undefined
})

/** A logger that records nothing. */
function silentLogger(): LanGuardLogger {
  return { info() {}, warn() {}, debug() {} }
}

/** Bring up a gated proxy over a fake upstream. */
async function harness(config: Record<string, unknown> = {}, password = PASSWORD): Promise<{
  fake: FakeDsh
  runtime: LanGuardRuntime
  port: number
}> {
  const upstream = await startFakeDsh()
  const started = await startLanGuard({
    authenticatedUrl: upstream.authenticatedUrl,
    logger: silentLogger(),
  }, {
    dataDir: await tmpDataDir(),
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    // These specs speak plain HTTP, so the listener must not serve TLS; the
    // TLS path has its own specs.
    tls: { mode: 'off' },
    ...config,
    // Pairing has its own specs; the rest of the suite focuses on the gate.
    auth: { allowLoopback: false, requirePairing: false, ...((config.auth as object | undefined) ?? {}) },
  })
  if (started === undefined) throw new Error('plugin did not start')
  if (password !== '') await started.auth.setPassword(password)
  fake = upstream
  runtime = started
  return { fake: upstream, runtime: started, port: started.proxy.port }
}

/** Extract one cookie pair from a response. */
function cookiePair(response: RawResponse, name: string): string {
  const raw = response.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  for (const entry of list) {
    if (entry.startsWith(`${name}=`)) return entry.split(';')[0] ?? ''
  }
  throw new Error(`cookie ${name} not found`)
}

/** Log in and return the session cookie pair. */
async function login(port: number, password = PASSWORD, headers: Record<string, string> = {}): Promise<RawResponse> {
  return await requestTo(port, {
    method: 'POST',
    path: '/__dsh_lan_guard__/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: `password=${encodeURIComponent(password)}&next=%2F`,
  })
}

/** Perform a raw WebSocket handshake. */
function upgradeTo(port: number, headers: Record<string, string> = {}): Promise<{ statusLine: string; socket: Socket }> {
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let buffer = ''
    let settled = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (settled || !buffer.includes('\r\n\r\n')) return
      settled = true
      resolve({ statusLine: buffer.split('\r\n')[0] ?? '', socket })
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (!settled) {
        settled = true
        resolve({ statusLine: 'closed', socket })
      }
    })
    socket.on('connect', () => {
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `host: 127.0.0.1:${String(port)}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${key}`,
        'sec-websocket-version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ]
      socket.write(lines.join('\r\n'))
    })
  })
}

describe('unauthenticated access', () => {
  it('serves the login page for an HTML navigation', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body.toString()).toContain('访问密码')
    expect(response.body.toString()).not.toContain('fake dsh index')
  })

  it('answers /api/* with 401 JSON, never a login page', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/api/remote.invoke', headers: { accept: '*/*' } })
    expect(response.status).toBe(401)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body.toString())).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('refuses static assets with a JSON error too', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/assets/index-abc.js' })
    expect(response.status).toBe(401)
  })

  it('never forwards an unauthenticated request upstream', async () => {
    const { fake: upstream, port } = await harness()
    await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(upstream.observed.filter(entry => !entry.url.includes('token='))).toHaveLength(0)
  })

  it('404s its own unknown paths instead of forwarding them', async () => {
    const { fake: upstream, port } = await harness()
    const response = await requestTo(port, { path: '/__dsh_lan_guard__/whatever' })
    expect(response.status).toBe(404)
    expect(upstream.observed.filter(entry => !entry.url.includes('token='))).toHaveLength(0)
  })
})

describe('password login', () => {
  it('rejects a wrong password and shows the error state', async () => {
    const { port } = await harness()
    const response = await login(port, 'wrong')
    expect(response.status).toBe(401)
    expect(response.body.toString()).toContain('密码错误')
  })

  it('accepts the right password, sets a session cookie and then forwards', async () => {
    const { port } = await harness()
    const response = await login(port)
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
    const session = cookiePair(response, 'dsh_lan_guard_session')

    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('fake dsh index')
  })

  it('never echoes the password back in the page', async () => {
    const { port } = await harness()
    const response = await login(port, 'wrong-but-secret')
    expect(response.body.toString()).not.toContain('wrong-but-secret')
  })

  it('locks the IP after the configured failures and says so', async () => {
    const { port } = await harness({ auth: { maxFailedAttempts: 2, lockoutMs: 60_000 } })
    await login(port, 'wrong')
    const locked = await login(port, 'wrong')
    expect(locked.status).toBe(429)
    expect(locked.body.toString()).toContain('尝试次数过多')

    // Even the correct password is refused while the lockout holds.
    const blocked = await login(port)
    expect(blocked.status).toBe(429)
  })

  it('refuses the login form when the CSRF check fails', async () => {
    const { port } = await harness()
    const response = await login(port, PASSWORD, { 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
    expect(response.body.toString()).toContain('请求来源校验未通过')
  })

  it('accepts an opaque Origin (in-app browsers post `Origin: null`)', async () => {
    // This is the real phone failure: the form post was answered with the CSRF
    // page instead of "wrong password" (user report 2026-09-24).
    const { port } = await harness()
    const response = await login(port, 'definitely-wrong', { origin: 'null', 'sec-fetch-site': 'same-origin' })
    expect(response.status).toBe(401)
    expect(response.body.toString()).toContain('密码错误')
    expect(response.body.toString()).not.toContain('请求来源校验未通过')
  })

  it('still refuses an explicit cross-site post', async () => {
    const { port } = await harness()
    const response = await login(port, PASSWORD, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
    expect(response.body.toString()).toContain('请求来源校验未通过')
  })

  it('never lets anyone in while no password is configured', async () => {
    const { port } = await harness({}, '')
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(page.status).toBe(403)
    expect(page.body.toString()).toContain('尚未设置访问密码')

    // A guessed password must not create a session.
    const attempt = await login(port, 'anything')
    expect(attempt.status).toBe(403)
    const after = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(after.status).toBe(403)
  })
})

describe('passwordless link', () => {
  it('exchanges ?auth= for a session and redirects to the clean URL', async () => {
    const { runtime: started, port } = await harness()
    const token = await started.auth.ensureSecretToken()
    const response = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
    const session = cookiePair(response, 'dsh_lan_guard_session')

    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })
    expect(page.status).toBe(200)
  })

  it('strips the token from the redirect target', async () => {
    const { runtime: started, port } = await harness()
    const token = await started.auth.ensureSecretToken()
    const response = await requestTo(port, { path: `/settings?auth=${token}&tab=1`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/settings?tab=1')
  })

  it('refuses an unknown token', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/?auth=dsh_deadbeef', headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('ignores the link in password-only mode', async () => {
    const { runtime: started, port } = await harness({ auth: { mode: 'password' } })
    const token = await started.auth.ensureSecretToken()
    const response = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
  })

  it('refuses password login in token-only mode', async () => {
    const { port } = await harness({ auth: { mode: 'token' } })
    const response = await login(port)
    expect(response.status).toBe(403)
    expect(response.body.toString()).toContain('仅安全 Token')
  })

  it('accepts a paired device link and rejects it once revoked', async () => {
    const { runtime: started, port } = await harness()
    const { device, token } = await started.devices.add('我的 iPhone')

    const response = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(302)
    const session = cookiePair(response, 'dsh_lan_guard_session')
    expect((await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })).status).toBe(200)

    await started.devices.revoke(device.id)
    const revoked = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(revoked.status).toBe(401)
    expect(revoked.headers['set-cookie']).toBeUndefined()
  })

  it('never forwards the auth parameter upstream', async () => {
    const { fake: upstream, runtime: started, port } = await harness()
    const token = await started.auth.ensureSecretToken()
    await requestTo(port, { path: `/?auth=${token}` })
    expect(upstream.observed.some(entry => entry.url.includes('auth='))).toBe(false)
  })
})

describe('device pairing (P4-g)', () => {
  it('asks an unnamed device to pair, then recognises it by its cookie', async () => {
    const { port } = await harness({ auth: { requirePairing: true } })
    const session = cookiePair(await login(port), 'dsh_lan_guard_session')

    // A valid session but no device identity -> the pairing page, not DSH.
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('确认这台设备')
    expect(page.body.toString()).not.toContain('fake dsh index')

    const paired = await requestTo(port, {
      method: 'POST',
      path: '/__dsh_lan_guard__/pair',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: `127.0.0.1:${String(port)}`,
        cookie: session,
      },
      body: 'label=%E6%88%91%E7%9A%84+iPhone',
    })
    expect(paired.status).toBe(302)
    const deviceCookie = cookiePair(paired, 'dsh_lan_guard_device')

    const allowed = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', cookie: deviceCookie },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.body.toString()).toContain('fake dsh index')
  })

  it('refuses a revoked device by its cookie', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { device, token } = await started.devices.add('旧手机')
    const cookie = `dsh_lan_guard_device=${token}`

    expect((await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })).status).toBe(200)

    await started.devices.revoke(device.id)
    const refused = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(refused.status).toBe(403)
    expect(refused.body.toString()).toContain('已被移除访问权限')
  })

  it('answers API calls with 428 while pairing is pending', async () => {
    const { port } = await harness({ auth: { requirePairing: true } })
    const session = cookiePair(await login(port), 'dsh_lan_guard_session')
    const response = await requestTo(port, { path: '/api/x', headers: { accept: '*/*', cookie: session } })
    expect(response.status).toBe(428)
    expect(JSON.parse(response.body.toString()).error).toBe('pairing_required')
  })
})

describe('websocket gate', () => {
  it('refuses an unauthenticated upgrade', async () => {
    const { port } = await harness()
    const result = await upgradeTo(port)
    expect(result.statusLine).toContain('401')
    result.socket.destroy()
  })

  it('allows an upgrade that carries a session cookie', async () => {
    const { port } = await harness()
    const response = await login(port)
    const session = cookiePair(response, 'dsh_lan_guard_session')
    const result = await upgradeTo(port, { cookie: session })
    expect(result.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    result.socket.destroy()
  })

  it('survives sockets dropped during authentication', async () => {
    const { port } = await harness()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('uncaughtException', onUnhandled)
    try {
      for (let index = 0; index < 8; index += 1) {
        const socket = connect(port, '127.0.0.1')
        await new Promise<void>(resolve => socket.on('connect', () => resolve()))
        socket.write(
          'GET /api/remote.mux HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\n'
          + 'connection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n',
        )
        socket.destroy()
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    } finally {
      process.off('uncaughtException', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

describe('loopback exemption', () => {
  it('lets a loopback visitor through when allowLoopback is set', async () => {
    const upstream = await startFakeDsh()
    const started = await startLanGuard({
      authenticatedUrl: upstream.authenticatedUrl,
      logger: silentLogger(),
    }, {
      dataDir: await tmpDataDir(),
      listenPort: 0,
      upstreamOrigin: upstream.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
    })
    if (started === undefined) throw new Error('plugin did not start')
    fake = upstream
    runtime = started
    const response = await requestTo(started.proxy.port, { path: '/', headers: { accept: 'text/html' } })
    expect(response.status).toBe(200)
  })
})
