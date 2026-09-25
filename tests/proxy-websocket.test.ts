/**
 * WebSocket upgrade tests.
 *
 * The upgrade path is the one the shipped UI depends on for its whole session
 * (`/api/remote.mux`), so it is tested over a real TCP socket rather than a
 * mocked stream: the handshake, the header whitelist and both pipe directions
 * are all exercised.
 */
import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { noopLogger } from '../src/log.ts'
import { startProxy, type RunningProxy } from '../src/proxy.ts'
import { UpstreamAuth } from '../src/upstream-auth.ts'
import { startFakeDsh, type FakeDsh, type FakeDshOptions } from './helpers/fake-dsh.ts'

let fake: FakeDsh | undefined
let proxy: RunningProxy | undefined

/** Bring up a fake upstream plus a proxy in front of it. */
async function harness(options: FakeDshOptions = {}): Promise<{ fake: FakeDsh; proxy: RunningProxy }> {
  const upstream = await startFakeDsh(options)
  const running = await startProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    auth: new UpstreamAuth({ origin: upstream.origin, authenticatedUrl: upstream.authenticatedUrl }),
    logger: noopLogger,
  })
  fake = upstream
  proxy = running
  return { fake: upstream, proxy: running }
}

afterEach(async () => {
  await proxy?.close()
  await fake?.close()
  proxy = undefined
  fake = undefined
})

/** One parsed upgrade response. */
interface UpgradeResult {
  socket: Socket
  statusLine: string
  headers: Record<string, string>
  /** Bytes that arrived after the response head. */
  rest: Buffer
}

/** Perform a raw WebSocket handshake against the proxy. */
function upgradeTo(port: number, options: { path?: string; host?: string; origin?: string } = {}): Promise<UpgradeResult> {
  const key = randomBytes(16).toString('base64')
  const host = options.host ?? `127.0.0.1:${String(port)}`
  return new Promise<UpgradeResult>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let buffer = Buffer.alloc(0)
    let settled = false

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1 || settled) return
      settled = true
      socket.off('data', onData)
      const text = buffer.subarray(0, end).toString('utf8')
      const [statusLine = '', ...headerLines] = text.split('\r\n')
      const headers: Record<string, string> = {}
      for (const line of headerLines) {
        const at = line.indexOf(':')
        if (at === -1) continue
        headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
      }
      resolve({ socket, statusLine, headers, rest: buffer.subarray(end + 4) })
    }

    socket.on('data', onData)
    socket.on('error', reject)
    socket.on('connect', () => {
      const lines = [
        `GET ${options.path ?? '/api/remote.mux'} HTTP/1.1`,
        `host: ${host}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${key}`,
        'sec-websocket-version: 13',
      ]
      if (options.origin !== undefined) lines.push(`origin: ${options.origin}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
  })
}

/** Wait for the next chunk of data, or time out. */
function nextChunk(socket: Socket, timeoutMs = 2_000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('data', onData)
      reject(new Error('timed out waiting for socket data'))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      clearTimeout(timer)
      resolve(chunk)
    }
    socket.once('data', onData)
  })
}

describe('WebSocket upgrades', () => {
  it('completes an /api/remote.mux handshake and relays bytes both ways', async () => {
    const { fake: upstream, proxy: running } = await harness()
    const result = await upgradeTo(running.port, {
      path: '/api/remote.mux',
      host: '192.168.1.5:3445',
      origin: 'http://192.168.1.5:3445',
    })

    expect(result.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    expect(result.headers.upgrade?.toLowerCase()).toBe('websocket')
    expect(result.headers['sec-websocket-accept']).toBeDefined()

    result.socket.write('hello-through-the-tunnel')
    const echoed = await nextChunk(result.socket)
    expect(echoed.toString()).toBe('hello-through-the-tunnel')
    result.socket.destroy()

    const seen = upstream.observedUpgrades[0]
    expect(seen?.url).toBe('/api/remote.mux')
    expect(seen?.headers.host).toBe(upstream.authority)
    expect(seen?.headers.origin).toBe(`http://${upstream.authority}`)
    expect(seen?.headers.cookie).toMatch(/^dsh-auth-/)
    expect(seen?.headers.upgrade?.toLowerCase()).toBe('websocket')
  })

  it('drops non-handshake headers the upstream adds to the 101', async () => {
    const { proxy: running } = await harness({ upgradeExtraHeaders: { 'x-bogus': 'nope' } })
    const result = await upgradeTo(running.port, { path: '/api/remote.mux' })
    expect(result.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    expect(result.headers['x-bogus']).toBeUndefined()
    result.socket.destroy()
  })

  it('relays a refusal instead of upgrading when the upstream rejects the socket', async () => {
    const { proxy: running } = await harness({ alwaysUnauthorized: true })
    const result = await upgradeTo(running.port, { path: '/api/remote.mux' })
    expect(result.statusLine).toContain('401')
    result.socket.destroy()
  })

  it('survives a socket dropped immediately after the upgrade request', async () => {
    const { proxy: running } = await harness()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('uncaughtException', onUnhandled)
    try {
      for (let index = 0; index < 5; index += 1) {
        const socket = connect(running.port, '127.0.0.1')
        await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
        socket.write(
          'GET /api/remote.mux HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\n'
          + 'connection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n',
        )
        socket.destroy()
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally {
      process.off('uncaughtException', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})
