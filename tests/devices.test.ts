/**
 * Paired-device tests (P4-g).
 *
 * The security-relevant promises: the token is returned once, only its hash is
 * stored, a revoked device stops authenticating, and the list never leaks a
 * credential.
 */
import { readFile, stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry, isDeviceToken } from '../src/store/devices.ts'
import { SecretsStore } from '../src/store/secrets.ts'
import { tmpDataDir } from './helpers/tmp.ts'

/** A registry over a fresh private data dir. */
async function registry(): Promise<{ registry: DeviceRegistry; store: SecretsStore }> {
  const store = new SecretsStore(await tmpDataDir())
  const created = new DeviceRegistry({ store })
  await created.init()
  return { registry: created, store }
}

describe('DeviceRegistry', () => {
  it('mints a device token and verifies it', async () => {
    const { registry: devices } = await registry()
    const { device, token } = await devices.add('我的 iPhone')
    expect(token).toMatch(/^dsh_dev_[0-9a-f]{36}$/)
    expect(isDeviceToken(token)).toBe(true)
    expect(device.label).toBe('我的 iPhone')
    expect(devices.verify(token)?.id).toBe(device.id)
    expect(devices.verify('dsh_dev_deadbeef')).toBeUndefined()
    expect(devices.verify('dsh_master_looking')).toBeUndefined()
  })

  it('never stores the plaintext token', async () => {
    const { registry: devices, store } = await registry()
    const { token } = await devices.add('iPad')
    const raw = await readFile(store.devicesPath, 'utf8')
    expect(raw).not.toContain(token)
    expect(raw).toContain('tokenHash')
    expect((await stat(store.devicesPath)).mode & 0o777).toBe(0o600)
  })

  it('stops authenticating a revoked device', async () => {
    const { registry: devices } = await registry()
    const { device, token } = await devices.add('旧手机')
    expect(await devices.revoke(device.id)).toBe(true)
    expect(devices.verify(token)).toBeUndefined()
    // Revoking twice is a no-op, not an error.
    expect(await devices.revoke(device.id)).toBe(false)
    expect(devices.list()[0]?.revokedAtMs).not.toBeNull()
  })

  it('persists devices across a restart', async () => {
    const store = new SecretsStore(await tmpDataDir())
    const first = new DeviceRegistry({ store })
    await first.init()
    const { token } = await first.add('手机')

    const second = new DeviceRegistry({ store })
    await second.init()
    expect(second.list()).toHaveLength(1)
    expect(second.verify(token)).toBeDefined()
    expect(second.activeCount).toBe(1)
  })

  it('records last use without touching the token', async () => {
    const { registry: devices } = await registry()
    const { device, token } = await devices.add('手机')
    await devices.touch(device.id, '10.0.0.9')
    const seen = devices.list()[0]
    expect(seen?.lastIp).toBe('10.0.0.9')
    expect(seen?.lastSeenAtMs).not.toBeNull()
    expect(devices.verify(token)).toBeDefined()
  })

  it('falls back to a placeholder label', async () => {
    const { registry: devices } = await registry()
    const { device } = await devices.add('   ')
    expect(device.label).toBe('未命名设备')
  })
})

describe('concurrent bookkeeping (the 2026-09-24 crash)', () => {
  it('survives many parallel touches and session writes', async () => {
    const store = new SecretsStore(await tmpDataDir())
    const devices = new DeviceRegistry({ store })
    await devices.init()
    const { device } = await devices.add('手机')

    // A loaded page fires dozens of requests at once; every one of them used to
    // rewrite devices.json through the SAME temporary path, so one rename won
    // and the rest rejected with ENOENT — an unhandled rejection that took dsh
    // down. Concurrent writes must simply all succeed now.
    await expect(Promise.all([
      ...Array.from({ length: 30 }, () => devices.touch(device.id, '10.0.0.9')),
      ...Array.from({ length: 30 }, () => store.saveDevices(devices.list())),
      ...Array.from({ length: 30 }, () => store.saveSessions([])),
    ])).resolves.toBeDefined()
  })

  it('throttles repeated touches from the same address', async () => {
    let now = 1_000_000
    const store = new SecretsStore(await tmpDataDir())
    const devices = new DeviceRegistry({ store, now: () => now })
    await devices.init()
    const { device } = await devices.add('手机')
    await devices.touch(device.id, '10.0.0.9')
    const first = devices.list()[0]?.lastSeenAtMs

    now += 1_000
    await devices.touch(device.id, '10.0.0.9')
    expect(devices.list()[0]?.lastSeenAtMs).toBe(first)

    // A new address, or enough time, records again.
    await devices.touch(device.id, '10.0.0.10')
    expect(devices.list()[0]?.lastIp).toBe('10.0.0.10')
  })
})
