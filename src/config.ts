/**
 * dsh-lan-guard — the non-sensitive configuration model.
 *
 * Everything here lands in a profile patch file (`cordis.patch.yml`), which is
 * plain text a user may share or commit, so NO credential ever belongs in this
 * schema (docs/SPEC.md F3 "存储位置" table). Passwords, hashes and the
 * passwordless-link token live in the plugin's private dataDir instead.
 *
 * This module owns two things:
 *
 * - `Config`: the Schemastery schema the Loader validates the entry with. On
 *   DSH 0.1.7 a plugin's own `Config` IS its settings form (Config-derived
 *   forms), which is why the field set below is the documented SPEC §5 field
 *   set rather than an internal one.
 * - `parseConfig`: the semantic checks Schemastery cannot express (loopback
 *   upstream, literal listen address, the `auth.enabled === false` bind rule,
 *   the required `dataDir`). Invalid values must be REJECTED — a silently
 *   widened default is the failure mode this module exists to prevent.
 */
import z from '@deepseek-ai/schemastery'

/** Gate mode (docs/SPEC.md F3). `scope` is deliberately absent — this project has one LAN channel. */
export type AuthMode = 'password' | 'token' | 'token_and_password'

/** Who may reach the management surface (docs/SPEC.md F3). */
export type AdminPolicy = 'password_unlock' | 'local_only' | 'open'

/** Certificate source (docs/SPEC.md F4). */
export type TlsMode = 'self-signed' | 'provided' | 'off'

/** The `auth` block of the config. */
export interface AuthConfigShape {
  /** Master switch for the visitor-side gate. `false` is only legal on a loopback listener. */
  enabled: boolean
  /** Which visitor credentials are accepted. */
  mode: AuthMode
  /** How the management surface unlocks. */
  adminPolicy: AdminPolicy
  /** Whether management operations need an explicit admin unlock on top of a session. */
  adminProtection: boolean
  /** Whether loopback visitors skip the gate (the local user already has direct DSH access). */
  allowLoopback: boolean
  /** Whether a new device must name itself once before it is let in (P4-g). */
  requirePairing: boolean
  /** Whether a new device also needs an operator's approval before it is let in (F9). */
  requireApproval: boolean
  /** Visitor session lifetime in milliseconds. */
  sessionMaxAgeMs: number
  /** Admin session lifetime in milliseconds (in-memory only, so it is deliberately short). */
  adminSessionMaxAgeMs: number
  /** Failed attempts per IP before the lockout window opens. */
  maxFailedAttempts: number
  /** Lockout window in milliseconds. */
  lockoutMs: number
}

/** The `tls` block of the config. */
export interface TlsConfigShape {
  /** Certificate source; `self-signed` is the default. */
  mode: TlsMode
  /** PEM CA certificate for `mode: 'provided'`. */
  caCertFile: string | null
  /** PEM CA private key for `mode: 'provided'`. */
  caKeyFile: string | null
  /** PEM leaf certificate for `mode: 'provided'`. */
  certFile: string | null
  /** PEM leaf private key for `mode: 'provided'`. */
  keyFile: string | null
  /**
   * Explicit acknowledgement required to serve plain HTTP on a NON-loopback
   * listener (P4-e). Defaults to false: the gate password and the upstream
   * cookie would travel the LAN in clear text (docs/SPEC.md §6.2).
   */
  allowInsecureLan: boolean
}

/** The full non-sensitive config shape (docs/SPEC.md §5). */
export interface MdnsConfigShape {
  /** Whether to advertise the console over mDNS/DNS-SD (off by default). */
  enabled: boolean
}

export interface LanGuardConfigShape {
  /** Plugin master switch; `false` registers nothing and opens no listener. */
  enabled: boolean
  /** Bind address: loopback, all interfaces, or one NIC literal. */
  listenHost: string
  /** Proxy port; `0` asks the OS for a free port (tests only). */
  listenPort: number
  /** The loopback origin requests are forwarded to. */
  upstreamOrigin: string
  /** Optional NIC selector (docs/SPEC.md F5). */
  networkInterface: string | null
  /** Private directory for sensitive state; required, never guessed. */
  dataDir: string | null
  /** Visitor-side gate configuration. */
  auth: AuthConfigShape
  /** Transport security configuration. */
  tls: TlsConfigShape
  /** Optional mDNS advertisement (P4-d). */
  mdns: MdnsConfigShape
}

/** Default bind address: loopback only, so a fresh install never exposes anything. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1'
/**
 * Default proxy port: DSH's own port + 1, which is the mental model the user
 * asked for ("3081, 3082, 3083 … take the first free one"). It stays clear of
 * 3080 (DSH itself), 3443 (dsh-mobile gateway) and 3444 (dsh-mobile origin).
 */
export const DEFAULT_LISTEN_PORT = 3081
/** How many consecutive ports to try when the configured one is taken. */
export const LISTEN_PORT_PROBE_ATTEMPTS = 10
/** Default upstream: DSH's own loopback web server. */
export const DEFAULT_UPSTREAM_ORIGIN = 'http://127.0.0.1:3080'

/**
 * The entry's config schema. Also the `dsh-lan-guard` settings form on DSH
 * 0.1.7 — the Loader entry id is the form namespace, so this object must stay
 * the documented field set.
 *
 * The five NON-SENSITIVE switches (docs/SPEC.md F6, PLAN §5 工作项 9) are
 * `.volatile()`: an edit commits into the running references and emits a
 * volatile update instead of remounting the plugin, and the host `settings`
 * service refuses to write any path that is not volatile
 * (docs/RESEARCH.md §4.1). A volatile field's runtime value is a stable
 * reference with `get()`, not the bare value — {@link parseConfig} unwraps it,
 * and {@link liveSwitches} keeps the reference so later edits are visible
 * without a restart.
 *
 * NOTE on the nullable fields: Schemastery treats a `null` default as "no
 * fallback" (`if (isNullable(fallback)) return [data]`), so a field declared
 * `.default(null)` stays `undefined` when omitted. The documented `null`
 * defaults are therefore expressed as an empty string in the schema and
 * normalized back to `null` in {@link parseConfig} — an explicit `null` in a
 * patch file is accepted and normalized the same way.
 */
export const Config: z<LanGuardConfigShape, Record<string, unknown>> = z.object({
  enabled: z.boolean().default(true).volatile(),
  listenHost: z.string().default(DEFAULT_LISTEN_HOST),
  listenPort: z.natural().max(65535).default(DEFAULT_LISTEN_PORT).volatile(),
  upstreamOrigin: z.string().default(DEFAULT_UPSTREAM_ORIGIN),
  networkInterface: z.string().default('').volatile(),
  dataDir: z.string().default(''),
  auth: z.object({
    // NOT volatile on purpose (PLAN §5 工作项 9 lists the writable switches):
    // the gate master switch is a startup-safety field (SPEC §5 principle 3),
    // so it must not be editable at runtime while the gate reads it statically.
    enabled: z.boolean().default(true),
    mode: z.union([z.const('password'), z.const('token'), z.const('token_and_password')])
      .default('token_and_password').volatile(),
    adminPolicy: z.union([z.const('password_unlock'), z.const('local_only'), z.const('open')])
      .default('local_only').volatile(),
    adminProtection: z.boolean().default(true).volatile(),
    allowLoopback: z.boolean().default(true).volatile(),
    requirePairing: z.boolean().default(true).volatile(),
    requireApproval: z.boolean().default(false).volatile(),
    sessionMaxAgeMs: z.natural().default(2_592_000_000),
    adminSessionMaxAgeMs: z.natural().default(1_800_000),
    maxFailedAttempts: z.natural().default(5),
    lockoutMs: z.natural().default(60_000),
  }),
  tls: z.object({
    mode: z.union([z.const('self-signed'), z.const('provided'), z.const('off')]).default('self-signed'),
    caCertFile: z.string().default(''),
    caKeyFile: z.string().default(''),
    certFile: z.string().default(''),
    keyFile: z.string().default(''),
    allowInsecureLan: z.boolean().default(false),
  }),
  mdns: z.object({
    enabled: z.boolean().default(false),
  }),
})

/** The live, non-sensitive switches. */
export interface LiveSwitches {
  /** Plugin master switch. */
  enabled(): boolean
  /** Selected NIC / address, or `null` for "pick automatically". */
  networkInterface(): string | null
  /** Configured listen port (applies on the next start). */
  listenPort(): number
  /** Visitor credential mode. */
  mode(): AuthMode
  /** Management unlock policy. */
  adminPolicy(): AdminPolicy
  /** Whether management operations need an explicit unlock. */
  adminProtection(): boolean
  /** Whether loopback visitors skip the gate. */
  allowLoopback(): boolean
  /** Whether an unnamed device must pair before it is let in. */
  requirePairing(): boolean
  /** Whether a paired device still needs the operator's approval (F9). */
  requireApproval(): boolean
}

/** Whether a resolved value is a volatile reference rather than a bare value. */
function isVolatileLike(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/** Read a possibly-volatile field, falling back when absent. */
function readField<T>(value: unknown, fallback: T): T {
  if (isVolatileLike(value)) return value.get() as T
  return value === undefined || value === null ? fallback : value as T
}

/**
 * Build the live switch accessors over a raw Loader config.
 *
 * When the Loader resolved the schema, the fields are volatile references, so
 * an edit made through the settings service is visible immediately. Tests and
 * plain objects fall back to the resolved values.
 *
 * @param rawConfig - the config as `apply` received it.
 * @param resolved - the normalized config from {@link parseConfig}.
 * @returns accessors for the five switches.
 */
export function liveSwitches(rawConfig: unknown, resolved: LanGuardConfigShape): LiveSwitches {
  const root = (typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}) as Record<string, unknown>
  const auth = (typeof root.auth === 'object' && root.auth !== null ? root.auth : {}) as Record<string, unknown>
  return {
    enabled: () => readField(root.enabled, resolved.enabled),
    networkInterface: () => emptyToNull(readField(root.networkInterface, '')),
    listenPort: () => readField(root.listenPort, resolved.listenPort),
    mode: () => readField(root.auth === undefined ? undefined : auth.mode, resolved.auth.mode),
    adminPolicy: () => readField(root.auth === undefined ? undefined : auth.adminPolicy, resolved.auth.adminPolicy),
    adminProtection: () => readField(
      root.auth === undefined ? undefined : auth.adminProtection,
      resolved.auth.adminProtection,
    ),
    allowLoopback: () => readField(root.auth === undefined ? undefined : auth.allowLoopback, resolved.auth.allowLoopback),
    requirePairing: () => readField(root.auth === undefined ? undefined : auth.requirePairing, resolved.auth.requirePairing),
    requireApproval: () => readField(
      root.auth === undefined ? undefined : auth.requireApproval,
      resolved.auth.requireApproval,
    ),
  }
}

/** Wrap plain values as live switches (used by tests and by callers without a raw config). */
export function staticSwitches(config: LanGuardConfigShape): LiveSwitches {
  return {
    enabled: () => config.enabled,
    networkInterface: () => config.networkInterface,
    listenPort: () => config.listenPort,
    mode: () => config.auth.mode,
    adminPolicy: () => config.auth.adminPolicy,
    adminProtection: () => config.auth.adminProtection,
    allowLoopback: () => config.auth.allowLoopback,
    requirePairing: () => config.auth.requirePairing,
    requireApproval: () => config.auth.requireApproval,
  }
}

/** Raised when a config value is syntactically valid but semantically unsafe. */
export class LanGuardConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LanGuardConfigError'
  }
}

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Whether an address literal is IPv4. Hostnames are rejected on purpose: a name can be re-resolved. */
export function isIpv4Literal(value: string): boolean {
  if (!IPV4_LITERAL.test(value)) return false
  return value.split('.').every(part => Number(part) <= 255)
}

/** Whether a host literal is loopback (IPv4 `127/8`, IPv6 `::1`, or `localhost`). */
export function isLoopbackHost(value: string): boolean {
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  if (!isIpv4Literal(value)) return false
  return value.split('.')[0] === '127'
}

/** Whether an origin URL points at this machine's loopback interface. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LanGuardConfigError(`dsh-lan-guard: ${field} must be a non-empty string`)
  }
  return value
}

/** Map an absent-or-blank optional path to the documented `null`. */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Apply defaults, then enforce every constraint Schemastery cannot express.
 *
 * @param input - the raw Loader config (or `undefined` for a bare `insert` row).
 * @returns the normalized, fully defaulted config.
 * @throws LanGuardConfigError when a value would make the listener unsafe.
 */
/**
 * Unwrap the volatile references of an already-resolved config.
 *
 * The Loader validates the entry through this schema BEFORE calling `apply`,
 * so at runtime `apply` receives the RESOLVED config: the five volatile
 * switches are `{ get() }` references, not booleans. Re-validating that value
 * as if it were the raw patch would reject it, so the references are unwrapped
 * first. Raw patches (tests, direct callers) pass through untouched.
 *
 * @param input - a raw patch or an already-resolved config.
 * @returns the same shape with volatile references replaced by their values.
 */
function unwrapVolatileInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const source = input as Record<string, unknown>
  const result: Record<string, unknown> = { ...source }
  for (const key of ['enabled', 'networkInterface', 'listenPort']) {
    const value = result[key]
    if (isVolatileLike(value)) result[key] = (value as { get(): unknown }).get()
  }
  if (typeof source.auth === 'object' && source.auth !== null) {
    const auth = { ...(source.auth as Record<string, unknown>) }
    for (const key of [
      'enabled', 'mode', 'adminPolicy', 'adminProtection', 'allowLoopback', 'requirePairing', 'requireApproval',
    ]) {
      const value = auth[key]
      if (isVolatileLike(value)) auth[key] = (value as { get(): unknown }).get()
    }
    result.auth = auth
  }
  return result
}

export function parseConfig(input: unknown): LanGuardConfigShape {
  let resolved: Record<string, unknown>
  try {
    // Schemastery applies the documented defaults and rejects wrong types; the
    // cast only carries the shape, the schema is the actual validator.
    resolved = Config(unwrapVolatileInput(input ?? {}) as LanGuardConfigShape) as unknown as Record<string, unknown>
  } catch (error) {
    throw new LanGuardConfigError(`dsh-lan-guard: invalid config: ${(error as Error).message}`)
  }

  const rawAuth = (resolved.auth ?? {}) as Record<string, unknown>
  const rawTls = (resolved.tls ?? {}) as Record<string, unknown>
  const rawMdns = (resolved.mdns ?? {}) as Record<string, unknown>

  const config: LanGuardConfigShape = {
    // The five switches are volatile references at runtime; unwrap them for the
    // plain resolved view. `liveSwitches()` keeps the references for liveness.
    enabled: readField(resolved.enabled, true),
    listenHost: readField(resolved.listenHost, DEFAULT_LISTEN_HOST),
    listenPort: readField(resolved.listenPort, DEFAULT_LISTEN_PORT),
    upstreamOrigin: readField(resolved.upstreamOrigin, DEFAULT_UPSTREAM_ORIGIN),
    networkInterface: emptyToNull(readField(resolved.networkInterface, '')),
    dataDir: emptyToNull(readField(resolved.dataDir, '')),
    auth: {
      enabled: readField(rawAuth.enabled, true),
      mode: readField(rawAuth.mode, 'token_and_password'),
      adminPolicy: readField(rawAuth.adminPolicy, 'local_only'),
      adminProtection: readField(rawAuth.adminProtection, true),
      allowLoopback: readField(rawAuth.allowLoopback, true),
      requirePairing: readField(rawAuth.requirePairing, true),
      requireApproval: readField(rawAuth.requireApproval, false),
      sessionMaxAgeMs: readField(rawAuth.sessionMaxAgeMs, 2_592_000_000),
      adminSessionMaxAgeMs: readField(rawAuth.adminSessionMaxAgeMs, 1_800_000),
      maxFailedAttempts: readField(rawAuth.maxFailedAttempts, 5),
      lockoutMs: readField(rawAuth.lockoutMs, 60_000),
    },
    tls: {
      mode: readField(rawTls.mode, 'self-signed'),
      caCertFile: emptyToNull(readField(rawTls.caCertFile, '')),
      caKeyFile: emptyToNull(readField(rawTls.caKeyFile, '')),
      certFile: emptyToNull(readField(rawTls.certFile, '')),
      keyFile: emptyToNull(readField(rawTls.keyFile, '')),
      allowInsecureLan: readField(rawTls.allowInsecureLan, false),
    },
    mdns: { enabled: readField(rawMdns.enabled, false) },
  }

  const dataDir = config.dataDir
  if (dataDir === null || dataDir.trim() === '') {
    throw new LanGuardConfigError(
      'dsh-lan-guard: dataDir is not set; the plugin never guesses a profile path — '
      + 'set it in this entry\'s config (cordis.patch.yml), e.g. dataDir: ~/.dsh/dsh-lan-guard',
    )
  }

  if (!isIpv4Literal(config.listenHost)) {
    throw new LanGuardConfigError(
      `dsh-lan-guard: listenHost ${JSON.stringify(config.listenHost)} must be an IPv4 literal `
      + "(e.g. '127.0.0.1', '0.0.0.0', or one NIC address)",
    )
  }

  if (!isLoopbackOrigin(config.upstreamOrigin)) {
    throw new LanGuardConfigError(
      `dsh-lan-guard: upstreamOrigin ${JSON.stringify(config.upstreamOrigin)} must be a loopback http(s) origin `
      + '(the gate cookie is injected into upstream requests, so a non-loopback upstream would leak it)',
    )
  }

  if (new URL(config.upstreamOrigin).protocol !== 'http:') {
    // DSH's own web server carries no TLS (docs/RESEARCH.md §2.2), and the
    // proxy forwards plain HTTP upstream only.
    throw new LanGuardConfigError(
      `dsh-lan-guard: upstreamOrigin ${JSON.stringify(config.upstreamOrigin)} must use http:// — `
      + "DSH's loopback web server does not serve TLS",
    )
  }

  if (!config.auth.enabled && !isLoopbackHost(config.listenHost)) {
    throw new LanGuardConfigError(
      `dsh-lan-guard: auth.enabled is false while listenHost is ${JSON.stringify(config.listenHost)}; `
      + 'the gate may only be disabled on a loopback listener',
    )
  }

  if (!isLoopbackHost(config.listenHost) && config.tls.mode === 'off' && !config.tls.allowInsecureLan) {
    // SPEC §6.2: plain HTTP on the LAN needs an explicit acknowledgement, not a
    // silent default — the gate password and the upstream cookie are readable
    // by anyone on the same network.
    throw new LanGuardConfigError(
      `dsh-lan-guard: listenHost ${JSON.stringify(config.listenHost)} with tls.mode "off" would serve the `
      + 'gate password and the upstream session over plain HTTP on the network. Enable TLS (the default '
      + 'self-signed mode), bind 127.0.0.1, or set tls.allowInsecureLan: true to accept that risk explicitly '
      + '(docs/SPEC.md §6.2).',
    )
  }

  if (config.auth.sessionMaxAgeMs <= 0) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.sessionMaxAgeMs must be greater than zero')
  }
  if (config.auth.adminSessionMaxAgeMs <= 0) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.adminSessionMaxAgeMs must be greater than zero')
  }
  if (config.auth.maxFailedAttempts < 1) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.maxFailedAttempts must be at least 1')
  }
  if (config.auth.lockoutMs < 0) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.lockoutMs must not be negative')
  }

  if (config.tls.mode === 'provided') {
    requireNonEmptyString(config.tls.certFile, 'tls.certFile')
    requireNonEmptyString(config.tls.keyFile, 'tls.keyFile')
  }

  return config
}
