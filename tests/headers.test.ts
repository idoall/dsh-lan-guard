/**
 * Header translation tests.
 *
 * These pin the two invariants the DSH fence depends on: the upstream always
 * sees its own loopback authority, and no hop-by-hop or credential-bearing
 * upstream header crosses the proxy hop.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import {
  HOP_BY_HOP_HEADERS,
  authorityOf,
  buildUpgradeResponseHead,
  buildUpstreamRequestHeaders,
  buildUpstreamResponseHeaders,
  isUpgradeRequest,
  normalizeRequestTarget,
} from '../src/headers.ts'

const AUTHORITY = '127.0.0.1:3080'

describe('authorityOf', () => {
  it('returns the host:port the upstream fence binds cookies to', () => {
    expect(authorityOf('http://127.0.0.1:3080')).toBe(AUTHORITY)
    expect(authorityOf('http://127.0.0.1:3080/')).toBe(AUTHORITY)
  })

  it('keeps the default port implicit the same way the URL parser does', () => {
    expect(authorityOf('http://127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('normalizeRequestTarget', () => {
  it('lands a bare origin on /', () => {
    expect(normalizeRequestTarget(undefined)).toBe('/')
    expect(normalizeRequestTarget('')).toBe('/')
    expect(normalizeRequestTarget('/')).toBe('/')
  })

  it('normalizes an absolute-form target with no path to /', () => {
    expect(normalizeRequestTarget('http://127.0.0.1:3445')).toBe('/')
    expect(normalizeRequestTarget('http://127.0.0.1:3445/')).toBe('/')
  })

  it('preserves the path and the exact query string', () => {
    expect(normalizeRequestTarget('/plugins/x.js?rev=abc')).toBe('/plugins/x.js?rev=abc')
    expect(normalizeRequestTarget('/?token=abc')).toBe('/?token=abc')
    expect(normalizeRequestTarget('/api/remote.mux')).toBe('/api/remote.mux')
  })

  it('normalizes an absolute-form target with a path', () => {
    expect(normalizeRequestTarget('http://127.0.0.1:3445/api/x?y=1')).toBe('/api/x?y=1')
  })

  it('adds the missing root for a query-only target', () => {
    expect(normalizeRequestTarget('?a=1')).toBe('/?a=1')
  })

  it('passes the asterisk-form target through', () => {
    expect(normalizeRequestTarget('*')).toBe('*')
  })
})

describe('buildUpstreamRequestHeaders', () => {
  it('rewrites host and origin to the upstream authority', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: { host: '192.168.1.5:3445', origin: 'http://192.168.1.5:3445', accept: 'text/html' },
      authority: AUTHORITY,
    })
    expect(headers.host).toBe(AUTHORITY)
    expect(headers.origin).toBe(`http://${AUTHORITY}`)
    expect(headers.accept).toBe('text/html')
  })

  it('does not invent an origin the browser never sent', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: { host: '192.168.1.5:3445' },
      authority: AUTHORITY,
    })
    expect(headers.origin).toBeUndefined()
  })

  it('replaces the visitor cookie with the injected loopback cookie', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: { host: '192.168.1.5:3445', cookie: 'dsh_lan_guard_session=visitor-secret' },
      authority: AUTHORITY,
      upstreamCookie: 'dsh-auth-abc=v1.payload.sig',
    })
    expect(headers.cookie).toBe('dsh-auth-abc=v1.payload.sig')
    expect(JSON.stringify(headers)).not.toContain('visitor-secret')
  })

  it('drops every hop-by-hop request header on a plain request', () => {    const headers = buildUpstreamRequestHeaders({
      headers: {
        host: '192.168.1.5:3445',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'proxy-authorization': 'Basic x',
        te: 'trailers',
        accept: '*/*',
      },
      authority: AUTHORITY,
    })
    for (const name of HOP_BY_HOP_HEADERS) expect(headers[name]).toBeUndefined()
    expect(headers.accept).toBe('*/*')
  })

  it('relays ONLY the named plugin cookie alongside the injected one', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: {
        host: '192.168.1.5:3445',
        cookie: 'dsh_lan_guard_session=gate-secret; dsh_lan_guard_admin=admin-token; theme=dark',
      },
      authority: AUTHORITY,
      upstreamCookie: 'dsh-auth-abc=v1.payload.sig',
      relayCookieNames: ['dsh_lan_guard_admin'],
    })
    // The injected upstream cookie is still the only DSH credential, and the
    // plugin's own admin session travels with it — without that the management
    // route behind the proxy could never see an unlock.
    expect(headers.cookie).toBe('dsh-auth-abc=v1.payload.sig; dsh_lan_guard_admin=admin-token')
    expect(JSON.stringify(headers)).not.toContain('gate-secret')
    expect(JSON.stringify(headers)).not.toContain('theme=dark')
  })

  it('relays nothing extra when the visitor holds no such cookie', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: { host: '192.168.1.5:3445', cookie: 'dsh_lan_guard_session=gate-secret' },
      authority: AUTHORITY,
      upstreamCookie: 'dsh-auth-abc=v1.payload.sig',
      relayCookieNames: ['dsh_lan_guard_admin'],
    })
    expect(headers.cookie).toBe('dsh-auth-abc=v1.payload.sig')
  })

  it('relays nothing at all without an injected cookie', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: { host: '192.168.1.5:3445', cookie: 'dsh_lan_guard_admin=admin-token' },
      authority: AUTHORITY,
      relayCookieNames: ['dsh_lan_guard_admin'],
    })
    expect(headers.cookie).toBeUndefined()
  })

  it('keeps connection/upgrade and the websocket handshake headers for an upgrade', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: {
        host: '192.168.1.5:3445',
        origin: 'http://192.168.1.5:3445',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
      authority: AUTHORITY,
      upstreamCookie: 'dsh-auth-abc=v1.payload.sig',
      upgrade: true,
    })
    expect(headers.connection).toBe('Upgrade')
    expect(headers.upgrade).toBe('websocket')
    expect(headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==')
    expect(headers.host).toBe(AUTHORITY)
    expect(headers.cookie).toBe('dsh-auth-abc=v1.payload.sig')
  })

  it('stamps the visitor marker and cannot be forged', () => {
    const forged = buildUpstreamRequestHeaders({
      headers: { host: 'h', 'x-dsh-lan-guard-visitor': '0' },
      authority: AUTHORITY,
    })
    expect(forged['x-dsh-lan-guard-visitor']).toBe('1')

    const plain = buildUpstreamRequestHeaders({ headers: { host: 'h' }, authority: AUTHORITY })
    expect(plain['x-dsh-lan-guard-visitor']).toBe('1')
  })

  it('preserves repeated header values', () => {
    const headers = buildUpstreamRequestHeaders({
      headers: { host: 'h', 'x-multi': ['a', 'b'] },
      authority: AUTHORITY,
    })
    expect(headers['x-multi']).toEqual(['a', 'b'])
  })
})

describe('buildUpstreamResponseHeaders', () => {
  it('drops hop-by-hop headers and the upstream session cookie', () => {
    const headers = buildUpstreamResponseHeaders({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'set-cookie': ['dsh-auth-abc=v1.payload.sig; HttpOnly'],
      'content-type': 'text/html',
      'content-length': '42',
      'cache-control': 'no-store',
    })
    for (const name of HOP_BY_HOP_HEADERS) expect(headers[name]).toBeUndefined()
    expect(headers['set-cookie']).toBeUndefined()
    expect(headers['content-type']).toBe('text/html')
    expect(headers['content-length']).toBe('42')
    expect(headers['cache-control']).toBe('no-store')
  })

  it('never leaks the upstream cookie value to the browser', () => {
    const headers = buildUpstreamResponseHeaders({
      'set-cookie': ['dsh-auth-abc=v1.payload.sig; HttpOnly', 'other=1'],
    })
    expect(JSON.stringify(headers)).not.toContain('dsh-auth-abc')
  })

  it('relays ONLY the named plugin cookie back to the browser', () => {
    const headers = buildUpstreamResponseHeaders({
      'set-cookie': [
        'dsh-auth-abc=v1.payload.sig; HttpOnly',
        'dsh_lan_guard_admin=fresh-token; Max-Age=1800; Path=/; HttpOnly; SameSite=Strict',
        'tracker=1',
      ],
    }, ['dsh_lan_guard_admin'])
    expect(headers['set-cookie']).toEqual([
      'dsh_lan_guard_admin=fresh-token; Max-Age=1800; Path=/; HttpOnly; SameSite=Strict',
    ])
    expect(JSON.stringify(headers)).not.toContain('dsh-auth-abc')
    expect(JSON.stringify(headers)).not.toContain('tracker')
  })
})

describe('buildUpgradeResponseHead', () => {
  it('relays only the whitelisted handshake headers', () => {
    const head = buildUpgradeResponseHead({
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-accept': 'accept-value',
      'sec-websocket-protocol': 'proto',
      'x-bogus': 'nope',
      'set-cookie': ['dsh-auth-abc=secret'],
    }, 101, 'Switching Protocols')
    expect(head.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true)
    expect(head).toContain('sec-websocket-accept: accept-value')
    expect(head).toContain('sec-websocket-protocol: proto')
    expect(head).not.toContain('x-bogus')
    expect(head).not.toContain('set-cookie')
    expect(head.endsWith('\r\n\r\n')).toBe(true)
  })

  it('emits repeated values as repeated header lines', () => {
    const repeated = { 'sec-websocket-protocol': ['a', 'b'] } as unknown as IncomingHttpHeaders
    const head = buildUpgradeResponseHead(repeated, 101, 'Switching Protocols')
    expect(head).toContain('sec-websocket-protocol: a\r\n')
    expect(head).toContain('sec-websocket-protocol: b\r\n')
  })
})

describe('isUpgradeRequest', () => {
  it('detects a websocket upgrade', () => {
    expect(isUpgradeRequest({ connection: 'Upgrade', upgrade: 'websocket' })).toBe(true)
    expect(isUpgradeRequest({ connection: 'keep-alive, Upgrade', upgrade: 'websocket' })).toBe(true)
    expect(isUpgradeRequest({ connection: 'Upgrade', upgrade: 'h2c' })).toBe(false)
    expect(isUpgradeRequest({ connection: 'keep-alive' })).toBe(false)
  })
})
