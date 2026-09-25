/**
 * dsh-lan-guard — update detection (SPEC F8).
 *
 * Asks the public npm registry what the latest published version is and
 * compares it with the version that is running. Read-only by design: this
 * module NEVER installs anything. The settings page shows the result plus a
 * copyable upgrade command, and the operator decides when to run it (and when
 * to restart dsh, which this plugin never does).
 *
 * The version comparison is implemented here on purpose: adding `semver` would
 * be a new runtime dependency for ~30 lines of
 * arithmetic.
 */
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'

/** Package name on npm. */
export const PACKAGE_NAME = 'dsh-lan-guard'
/** Registry document that carries the `latest` tag. */
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
/** How long a successful (or failed) lookup is reused before asking again. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1_000
/** Network timeout for the lookup. */
export const FETCH_TIMEOUT_MS = 5_000

/** Parsed `major.minor.patch` plus optional prerelease identifiers. */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers, e.g. `['rc', '1']`; empty for a release. */
  prerelease: string[]
}

/**
 * Parse a version string.
 *
 * @param value - e.g. `0.1.1`, `0.1.2-rc.1`.
 * @returns the parsed version, or `undefined` when it is not a version.
 */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two prerelease identifier lists per semver's precedence rules. */
function comparePrerelease(left: string[], right: string[]): number {
  // A release outranks any prerelease of the same x.y.z.
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined
    if (aNumber !== undefined && bNumber !== undefined) {
      if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1
      continue
    }
    if (aNumber !== undefined) return -1
    if (bNumber !== undefined) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Compare two versions.
 *
 * @param left - first version.
 * @param right - second version.
 * @returns `-1`, `0` or `1`; an unparsable version compares as equal.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return 0
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** Whether `latest` is newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

/** The result shown in the settings page. */
export interface UpdateStatus {
  /** The version that is running. */
  current: string
  /** The newest version on npm, or `null` when the lookup failed. */
  latest: string | null
  /** Whether a newer version exists. */
  hasUpdate: boolean
  /** When the lookup last succeeded (ms since epoch), or `null`. */
  checkedAtMs: number | null
  /** Language-neutral failure code, or `null` on success. */
  error: string | null
}

/** Options for {@link UpdateChecker}. */
export interface UpdateCheckerOptions {
  /** The running version. */
  currentVersion: string
  logger?: LanGuardLogger
  /** Injected for tests. */
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
}

/** Reads the npm registry with a cache; never throws. */
export class UpdateChecker {
  readonly #currentVersion: string
  readonly #logger: LanGuardLogger
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #ttlMs: number
  #cached: UpdateStatus | undefined

  constructor(options: UpdateCheckerOptions) {
    this.#currentVersion = options.currentVersion
    this.#logger = options.logger ?? noopLogger
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.ttlMs ?? CACHE_TTL_MS
  }

  /** The version this process is running. */
  get currentVersion(): string {
    return this.#currentVersion
  }

  /**
   * Look up the latest published version.
   *
   * @param options - `force` bypasses the cache.
   * @returns the status; a failure is reported in `error`, never thrown.
   */
  async check(options: { force?: boolean } = {}): Promise<UpdateStatus> {
    if (options.force !== true && this.#cached !== undefined) {
      const age = this.#now() - (this.#cached.checkedAtMs ?? 0)
      if (age < this.#ttlMs) return this.#cached
    }
    let status: UpdateStatus
    try {
      const response = await this.#fetch(REGISTRY_LATEST_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`registry ${String(response.status)}`)
      const body = await response.json() as { version?: unknown }
      const latest = typeof body.version === 'string' ? body.version : null
      if (latest === null) throw new Error('registry response had no version')
      status = {
        current: this.#currentVersion,
        latest,
        hasUpdate: isNewer(latest, this.#currentVersion),
        checkedAtMs: this.#now(),
        error: null,
      }
      if (status.hasUpdate) {
        this.#logger.info('update available current=%s latest=%s', status.current, latest)
      }
    } catch (error) {
      // Offline is a normal state: report it, keep the gate and proxy running.
      this.#logger.warn('update check failed name=%s', (error as Error).name)
      status = {
        current: this.#currentVersion,
        latest: null,
        hasUpdate: false,
        checkedAtMs: this.#now(),
        error: 'registry_unavailable',
      }
    }
    this.#cached = status
    return status
  }
}
