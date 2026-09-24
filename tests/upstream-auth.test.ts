/**
 * Route A tests: the loopback cookie the proxy injects upstream
 * (docs/SPEC.md F2, docs/RESEARCH.md §3.3/§3.4).
 *
 * The fake upstream reproduces DSH's real exchange shape (303 + Set-Cookie +
 * `Location: ./`) and binds the cookie name to the request authority, so a
 * passing test also proves the exchange request carried the upstream `host`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LanGuardLogger } from '../src/log.ts'
import { UpstreamAuth, UpstreamAuthError } from '../src/upstream-auth.ts'
import { fakeCookieName, startFakeDsh, type FakeDsh } from './helpers/fake-dsh.ts'

const TOKEN = 'fake-launch-token'

let running: FakeDsh | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A logger that records every call so tests can prove nothing leaked. */
function recordingLogger(): { logger: LanGuardLogger; calls: string[] } {
  const calls: string[] = []
  const record = (message: string, ...args: unknown[]): void => {
    calls.push([message, ...args.map(arg => String(arg))].join(' '))
  }
  return { logger: { info: record, warn: record, debug: record }, calls }
}

describe('UpstreamAuth', () => {
  it('exchanges the launch token for a cookie bound to the upstream authority', async () => {
    running = await startFakeDsh({ launchToken: TOKEN })
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl })

    const cookie = await auth.cookieHeader()
    expect(cookie).toBe(`${fakeCookieName(running.authority)}=v1.fake-payload.fake-signature`)
    expect(running.exchangeCount()).toBe(1)
    expect(running.observed[0]?.url).toBe(`/?token=${TOKEN}`)
    expect(running.observed[0]?.headers.host).toBe(running.authority)
  })

  it('caches the session across calls', async () => {
    running = await startFakeDsh()
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl })

    const first = await auth.cookieHeader()
    const second = await auth.cookieHeader()
    expect(second).toBe(first)
    expect(running.exchangeCount()).toBe(1)
  })

  it('deduplicates concurrent exchanges', async () => {
    running = await startFakeDsh()
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl })

    const [a, b, c] = await Promise.all([auth.cookieHeader(), auth.cookieHeader(), auth.cookieHeader()])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(running.exchangeCount()).toBe(1)
  })

  it('re-exchanges when the process launch token changes', async () => {
    running = await startFakeDsh({ launchToken: TOKEN })
    let token = TOKEN
    const auth = new UpstreamAuth({
      origin: running.origin,
      authenticatedUrl: (base) => {
        const url = new URL(base)
        url.searchParams.set('token', token)
        return url.href
      },
    })

    await auth.cookieHeader()
    token = 'rotated-launch-token'
    await auth.cookieHeader()
    expect(running.exchangeCount()).toBe(2)
  })

  it('re-exchanges before the cookie expires', async () => {
    running = await startFakeDsh({ cookieMaxAgeSeconds: 120 })
    let now = 1_000_000
    const auth = new UpstreamAuth({
      origin: running.origin,
      authenticatedUrl: running.authenticatedUrl,
      now: () => now,
    })

    await auth.cookieHeader()
    now += 30_000
    await auth.cookieHeader()
    expect(running.exchangeCount()).toBe(1)

    // 70s into a 120s cookie: inside the 60s refresh skew.
    now += 40_000
    await auth.cookieHeader()
    expect(running.exchangeCount()).toBe(2)
  })

  it('re-exchanges after invalidate()', async () => {
    running = await startFakeDsh()
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl })

    await auth.cookieHeader()
    auth.invalidate('test')
    await auth.cookieHeader()
    expect(running.exchangeCount()).toBe(2)
  })

  it('fails when the upstream does not answer with 303', async () => {
    running = await startFakeDsh({ exchangeStatus: 401 })
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl })
    await expect(auth.cookieHeader()).rejects.toBeInstanceOf(UpstreamAuthError)
  })

  it('fails when the exchange returns no cookie', async () => {
    running = await startFakeDsh({ exchangeWithoutCookie: true })
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl })
    await expect(auth.cookieHeader()).rejects.toThrow(/no session cookie/)
  })

  it('fails when the seam offers no launch token', async () => {
    running = await startFakeDsh()
    const auth = new UpstreamAuth({
      origin: running.origin,
      authenticatedUrl: (base) => base,
    })
    await expect(auth.cookieHeader()).rejects.toThrow(/no launch token/)
  })

  it('wraps an unreachable upstream in UpstreamAuthError', async () => {
    running = await startFakeDsh()
    const dead = new UpstreamAuth({
      origin: 'http://127.0.0.1:1',
      authenticatedUrl: running.authenticatedUrl,
    })
    await expect(dead.cookieHeader()).rejects.toBeInstanceOf(UpstreamAuthError)
  })

  it('never logs the launch token or the cookie value', async () => {
    running = await startFakeDsh({ launchToken: TOKEN })
    const { logger, calls } = recordingLogger()
    const auth = new UpstreamAuth({ origin: running.origin, authenticatedUrl: running.authenticatedUrl, logger })

    const cookie = await auth.cookieHeader()
    auth.invalidate('test')
    await auth.cookieHeader()

    const log = calls.join('\n')
    expect(log).not.toContain(TOKEN)
    expect(log).not.toContain(cookie.split('=')[1] ?? '')
    expect(log).not.toContain('fake-signature')
  })
})
