/**
 * dsh-lan-guard — paired devices (P4-g).
 *
 * The master passwordless link (`secretToken`) is all-or-nothing: revoking it
 * logs out every phone at once. Paired devices give the operator one revocable
 * credential per phone, so a lost device can be cut off without disturbing the
 * others.
 *
 * Credential hygiene (docs/GUARDRAILS.md §4):
 *
 * - the plaintext token is returned exactly ONCE, when the device is created;
 * - only its SHA-256 hash is persisted, with mode 600, in the plugin dataDir;
 * - comparison is constant-time, and a revoked device never authenticates.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'
import type { SecretsStore, DeviceRecord } from './secrets.ts'

/** How long a device's "last seen" may go unrefreshed before it is rewritten. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1_000

/** Prefix that distinguishes a device token from the master passwordless token. */
const DEVICE_TOKEN_PREFIX = 'dsh_dev_'

/** Whether a presented token is shaped like a device token. */
export function isDeviceToken(token: string): boolean {
  return token.startsWith(DEVICE_TOKEN_PREFIX)
}

/** SHA-256 hex of a token; only this ever reaches disk. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Options for {@link DeviceRegistry}. */
export interface DeviceRegistryOptions {
  store: SecretsStore
  logger?: LanGuardLogger
  now?: () => number
}

/** The paired-device registry. */
export class DeviceRegistry {
  readonly #store: SecretsStore
  readonly #logger: LanGuardLogger
  readonly #now: () => number
  #devices: DeviceRecord[] = []

  constructor(options: DeviceRegistryOptions) {
    this.#store = options.store
    this.#logger = options.logger ?? noopLogger
    this.#now = options.now ?? (() => Date.now())
  }

  /** Load the persisted device list. */
  async init(): Promise<void> {
    this.#devices = await this.#store.loadDevices()
  }

  /** Active and revoked devices, newest first. */
  list(): DeviceRecord[] {
    return [...this.#devices].sort((left, right) => right.createdAtMs - left.createdAtMs)
  }

  /** Number of active (non-revoked) devices. */
  get activeCount(): number {
    return this.#devices.filter(device => device.revokedAtMs === null).length
  }

  /**
   * Create a device and return its token ONCE.
   *
   * @param label - operator-facing name.
   * @returns the stored record plus the plaintext token.
   */
  async add(label: string): Promise<{ device: DeviceRecord; token: string }> {
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(18).toString('hex')}`
    const device: DeviceRecord = {
      id: randomBytes(4).toString('hex'),
      label: label.trim() === '' ? '未命名设备' : label.trim().slice(0, 60),
      tokenHash: hashToken(token),
      createdAtMs: this.#now(),
      lastSeenAtMs: null,
      lastIp: null,
      revokedAtMs: null,
    }
    this.#devices = [...this.#devices, device]
    await this.#store.saveDevices(this.#devices)
    // Only the id and label are logged — never the token.
    this.#logger.info('device paired id=%s label=%s', device.id, device.label)
    return { device, token }
  }

  /**
   * Revoke a device.
   *
   * @param id - device id.
   * @returns whether a device was revoked.
   */
  async revoke(id: string): Promise<boolean> {
    const target = this.#devices.find(device => device.id === id)
    if (target === undefined || target.revokedAtMs !== null) return false
    const revokedAtMs = this.#now()
    this.#devices = this.#devices.map(device => (
      device.id === id ? { ...device, revokedAtMs } : device
    ))
    await this.#store.saveDevices(this.#devices)
    this.#logger.info('device revoked id=%s', id)
    return true
  }

  /**
   * Delete a device record entirely, so the device may pair again.
   *
   * @param id - device id.
   * @returns whether a record was removed.
   */
  async remove(id: string): Promise<boolean> {
    const before = this.#devices.length
    this.#devices = this.#devices.filter(device => device.id !== id)
    if (this.#devices.length === before) return false
    await this.#store.saveDevices(this.#devices)
    return true
  }

  /**
   * Verify a presented device token.
   *
   * @param token - the `?auth=` value.
   * @returns the matching active device, or `undefined`.
   */
  verify(token: string): DeviceRecord | undefined {
    if (!isDeviceToken(token)) return undefined
    const presented = Buffer.from(hashToken(token), 'utf8')
    for (const device of this.#devices) {
      if (device.revokedAtMs !== null) continue
      const stored = Buffer.from(device.tokenHash, 'utf8')
      if (stored.byteLength !== presented.byteLength) continue
      if (timingSafeEqual(stored, presented)) return device
    }
    return undefined
  }

  /**
   * Record that a device just used its link.
   *
   * Throttled: a loaded page issues dozens of requests, and rewriting the file
   * on each one is both wasteful and a crash risk (see {@link writeJson}).
   *
   * @param id - device id.
   * @param ip - the address the request came from.
   */
  async touch(id: string, ip: string): Promise<void> {
    const now = this.#now()
    const target = this.#devices.find(device => device.id === id)
    if (target === undefined) return
    const recentlySeen = target.lastSeenAtMs !== null
      && now - target.lastSeenAtMs < TOUCH_INTERVAL_MS
      && target.lastIp === ip
    if (recentlySeen) return
    this.#devices = this.#devices.map(device => (
      device.id === id ? { ...device, lastSeenAtMs: now, lastIp: ip } : device
    ))
    await this.#store.saveDevices(this.#devices)
  }
}
