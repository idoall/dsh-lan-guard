/**
 * dsh-lan-guard — sensitive state on disk.
 *
 * Everything a user would not want in a shareable text file lives here, under
 * the plugin's private `dataDir`, with file mode 600 (docs/SPEC.md F3
 * "存储位置", docs/GUARDRAILS.md §4):
 *
 * - the access password hash + salt,
 * - the independent admin password hash + salt,
 * - the passwordless-link token (`secretToken`),
 * - persistent visitor sessions.
 *
 * Admin sessions are deliberately NOT persisted: they are memory-only and die
 * with the process (docs/SPEC.md F3).
 *
 * No value read or written here is ever logged; only names and lengths may be.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'

/** The persisted secrets document. */
export interface SecretsFile {
  version: 1
  /** `pbkdf2-sha256$<iterations>$<hex>`, or a legacy bare hex digest. */
  passwordHash: string | null
  /** Salt as hex. */
  passwordSalt: string | null
  /** Independent admin password hash, same format. */
  adminPasswordHash: string | null
  /** Admin salt as hex. */
  adminPasswordSalt: string | null
  /** Passwordless-link token: `dsh_` + 36 hex characters. */
  secretToken: string | null
}

/** One paired device. The plaintext token is NEVER stored — only its hash. */
export interface DeviceRecord {
  /** Short opaque id used by the UI. */
  id: string
  /** Operator-supplied label ("iPhone", "iPad"…). */
  label: string
  /** SHA-256 (hex) of the device token. */
  tokenHash: string
  /** Creation time. */
  createdAtMs: number
  /** Last time this device used its link. */
  lastSeenAtMs: number | null
  /** Address the device last came from. */
  lastIp: string | null
  /** Revocation time, or `null` while active. */
  revokedAtMs: number | null
  /** F9 state: pending approval, approved, or permanently blocked. */
  status: DeviceStatus
  /** When the operator decided (approved / blocked), or `null`. */
  decidedAtMs: number | null
}

/** F9 device states. */
export type DeviceStatus = 'pending' | 'approved' | 'blocked'

/** One persisted visitor session. */
export interface SessionRecord {
  /** Opaque session token (the cookie value). */
  token: string
  /** Absolute expiry in epoch milliseconds. */
  expiresAtMs: number
  /** When it was created, for diagnostics. */
  createdAtMs: number
}

/** An empty secrets document. */
export function emptySecrets(): SecretsFile {
  return {
    version: 1,
    passwordHash: null,
    passwordSalt: null,
    adminPasswordHash: null,
    adminPasswordSalt: null,
    secretToken: null,
  }
}

/** Read and validate one JSON document, returning `undefined` when absent or unusable. */
async function readJson<T>(path: string, logger: LanGuardLogger): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupted secrets file must not be silently replaced with an empty one
    // (that would silently reopen the gate), so the caller decides.
    logger.warn('ignoring unreadable json path=%s', path)
    return undefined
  }
}

/**
 * Per-path write queue.
 *
 * Two writes to the same document must never interleave: with a SHARED
 * temporary name one `rename` wins and the other fails with ENOENT, and that
 * rejection used to escape the request path and kill the whole dsh process
 * (2026-09-24: "如果手机访问 DS，也会崩溃" — a phone fires dozens of parallel
 * requests, each of which refreshed the device's "last seen").
 */
const writeQueues = new Map<string, Promise<void>>()

/** Write one JSON document atomically with mode 600. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const body = `${JSON.stringify(value, null, 2)}\n`
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.then(async () => {
    // Unique temporary name as well: belt and braces against a stale queue.
    const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600)
  })
  // Keep the chain alive even if this write fails, so the next one still runs.
  writeQueues.set(path, next.catch(() => undefined))
  return await next
}

/**
 * Owns the plugin's private data directory.
 */
export class SecretsStore {
  /** Absolute plugin data directory (never guessed — it comes from config). */
  readonly #dataDir: string
  readonly #logger: LanGuardLogger

  constructor(dataDir: string, logger: LanGuardLogger = noopLogger) {
    this.#dataDir = dataDir
    this.#logger = logger
  }

  /** Absolute path of the secrets document. */
  get secretsPath(): string {
    return join(this.#dataDir, 'secrets.json')
  }

  /** Absolute path of the persistent session document. */
  get sessionsPath(): string {
    return join(this.#dataDir, 'sessions.json')
  }

  /** Absolute path of the paired-device document. */
  get devicesPath(): string {
    return join(this.#dataDir, 'devices.json')
  }

  /** Create the private directory if needed. */
  async ensureDir(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 })
  }

  /**
   * Load the secrets document.
   *
   * @returns the stored secrets, or an empty document when none exists yet.
   * @throws when the file exists but is unreadable — refusing to start beats
   *   starting with an empty password (the "any password works" failure).
   */
  async loadSecrets(): Promise<SecretsFile> {
    const parsed = await readJson<SecretsFile>(this.secretsPath, this.#logger)
    if (parsed === undefined) return emptySecrets()
    if (parsed.version !== 1) {
      throw new Error('dsh-lan-guard: unsupported secrets.json version; refusing to start')
    }
    return { ...emptySecrets(), ...parsed }
  }

  /** Persist the secrets document with mode 600. */
  async saveSecrets(secrets: SecretsFile): Promise<void> {
    await writeJson(this.secretsPath, secrets)
  }

  /** Load persisted visitor sessions; a corrupt file yields an empty list (sessions are renewable). */
  async loadSessions(): Promise<SessionRecord[]> {
    const parsed = await readJson<SessionRecord[]>(this.sessionsPath, this.#logger)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((record): record is SessionRecord => (
      typeof record === 'object'
      && record !== null
      && typeof (record as SessionRecord).token === 'string'
      && typeof (record as SessionRecord).expiresAtMs === 'number'
    ))
  }

  /** Persist visitor sessions with mode 600. */
  async saveSessions(records: readonly SessionRecord[]): Promise<void> {
    await writeJson(this.sessionsPath, records)
  }

  /** Load paired devices; a corrupt file yields an empty list (no device is trusted by default). */
  async loadDevices(): Promise<DeviceRecord[]> {
    const parsed = await readJson<{ version?: number; devices?: unknown }>(this.devicesPath, this.#logger)
    if (parsed === undefined || !Array.isArray(parsed.devices)) return []
    return parsed.devices
      .filter((entry): entry is DeviceRecord => (
        typeof entry === 'object' && entry !== null
        && typeof (entry as DeviceRecord).id === 'string'
        && typeof (entry as DeviceRecord).label === 'string'
        && typeof (entry as DeviceRecord).tokenHash === 'string'
      ))
      // Records written before F9 have no status: they were let in, so they
      // stay approved. Migration happens on load, never on disk eagerly.
      .map(entry => ({
        ...entry,
        status: entry.status === 'pending' || entry.status === 'blocked' ? entry.status : 'approved',
        decidedAtMs: entry.decidedAtMs ?? null,
      }))
  }

  /** Persist paired devices with mode 600. */
  async saveDevices(devices: readonly DeviceRecord[]): Promise<void> {
    await writeJson(this.devicesPath, { version: 1, devices })
  }
}
