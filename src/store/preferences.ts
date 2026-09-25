/**
 * dsh-lan-guard — the non-sensitive preference surface of the settings channel.
 *
 * Non-sensitive switches live in the plugin's own `Config`, and on DSH 0.1.7
 * the host `settings` service is the only correct writer for them: it commits
 * the edit into the profile patch and into the running references
 * (docs/RESEARCH.md §4.1). This module is the whitelist and validation layer
 * in front of that writer, so the `/config` endpoint can never write an
 * unknown key, a non-volatile field, or an out-of-range value.
 *
 * Secrets never pass through here: passwords and the passwordless-link token
 * are handled by `store/secrets.ts` and the auth manager.
 */
import type { AdminPolicy, AuthMode } from '../config.ts'

/** The non-sensitive switches the settings page may change. */
export interface PreferenceValues {
  enabled: boolean
  /** Configured proxy port (applies on the next start). */
  listenPort: number
  /** Selected NIC name or address; empty string means "automatic". */
  networkInterface: string
  /** Whether a new device must name itself once before it is let in. */
  requirePairing: boolean
  /** Whether a new device also needs the operator's approval (F9). */
  requireApproval: boolean
  mode: AuthMode
  adminPolicy: AdminPolicy
  adminProtection: boolean
  allowLoopback: boolean
}

/** The switch keys, in display order. */
export const PREFERENCE_KEYS = [
  'enabled', 'listenPort', 'networkInterface', 'mode', 'adminPolicy', 'adminProtection', 'allowLoopback',
  'requirePairing', 'requireApproval',
] as const

/** One preference key. */
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number]

/** Values accepted by each enumerated switch. */
const AUTH_MODES: readonly AuthMode[] = ['password', 'token', 'token_and_password']
const ADMIN_POLICIES: readonly AdminPolicy[] = ['password_unlock', 'local_only', 'open']

/** Raised when a patch carries a value the endpoint must refuse. */
export class PreferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreferenceError'
  }
}

/** Read the current values off a resolved config. */
export function readPreferences(config: {
  enabled: boolean
  listenPort: number
  networkInterface: string | null
  auth: {
    mode: AuthMode
    adminPolicy: AdminPolicy
    adminProtection: boolean
    allowLoopback: boolean
    requirePairing: boolean
    requireApproval: boolean
  }
}): PreferenceValues {
  return {
    enabled: config.enabled,
    listenPort: config.listenPort,
    networkInterface: config.networkInterface ?? '',
    requirePairing: config.auth.requirePairing,
    requireApproval: config.auth.requireApproval,
    mode: config.auth.mode,
    adminPolicy: config.auth.adminPolicy,
    adminProtection: config.auth.adminProtection,
    allowLoopback: config.auth.allowLoopback,
  }
}

/**
 * Validate one client-supplied patch, dropping unknown keys.
 *
 * Dropping is deliberate (docs/SPEC.md F6): an unknown key is either a typo or
 * an attempt to reach a field this endpoint does not own, and neither may
 * reach the settings writer.
 *
 * @param patch - the decoded JSON body.
 * @returns only the known keys, validated.
 * @throws PreferenceError when a known key carries an invalid value.
 */
export function sanitizePreferencePatch(patch: unknown): Partial<PreferenceValues> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new PreferenceError('dsh-lan-guard: config patch must be a JSON object')
  }
  const source = patch as Record<string, unknown>
  const result: Partial<PreferenceValues> = {}

  if (Object.hasOwn(source, 'enabled')) {
    if (typeof source.enabled !== 'boolean') throw new PreferenceError('enabled must be a boolean')
    result.enabled = source.enabled
  }
  if (Object.hasOwn(source, 'listenPort')) {
    const value = source.listenPort
    // 0 means "let the OS pick one" (tests); otherwise a real port number.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
      throw new PreferenceError('listenPort must be an integer between 0 and 65535')
    }
    result.listenPort = value
  }
  if (Object.hasOwn(source, 'networkInterface')) {
    const value = source.networkInterface
    // An empty string means "pick automatically"; anything else must be a
    // plausible interface name or IPv4 literal, never an arbitrary string.
    if (typeof value !== 'string') throw new PreferenceError('networkInterface must be a string')
    if (value !== '' && !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
      throw new PreferenceError('networkInterface must be an interface name or an address literal')
    }
    result.networkInterface = value
  }
  if (Object.hasOwn(source, 'requireApproval')) {
    if (typeof source.requireApproval !== 'boolean') throw new PreferenceError('requireApproval must be a boolean')
    result.requireApproval = source.requireApproval
  }
  if (Object.hasOwn(source, 'requirePairing')) {
    if (typeof source.requirePairing !== 'boolean') throw new PreferenceError('requirePairing must be a boolean')
    result.requirePairing = source.requirePairing
  }
  if (Object.hasOwn(source, 'mode')) {
    if (!AUTH_MODES.includes(source.mode as AuthMode)) {
      throw new PreferenceError(`mode must be one of ${AUTH_MODES.join(', ')}`)
    }
    result.mode = source.mode as AuthMode
  }
  if (Object.hasOwn(source, 'adminPolicy')) {
    if (!ADMIN_POLICIES.includes(source.adminPolicy as AdminPolicy)) {
      throw new PreferenceError(`adminPolicy must be one of ${ADMIN_POLICIES.join(', ')}`)
    }
    result.adminPolicy = source.adminPolicy as AdminPolicy
  }
  if (Object.hasOwn(source, 'adminProtection')) {
    if (typeof source.adminProtection !== 'boolean') throw new PreferenceError('adminProtection must be a boolean')
    result.adminProtection = source.adminProtection
  }
  if (Object.hasOwn(source, 'allowLoopback')) {
    if (typeof source.allowLoopback !== 'boolean') throw new PreferenceError('allowLoopback must be a boolean')
    result.allowLoopback = source.allowLoopback
  }
  return result
}

/**
 * Flatten preference values into the nested patch the host settings writer
 * expects (`{ auth: { mode } }`, not `{ mode }`).
 *
 * @param values - validated values.
 * @returns a nested patch containing only the keys that were supplied.
 */
export function toSettingsPatch(values: Partial<PreferenceValues>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const auth: Record<string, unknown> = {}
  if (values.enabled !== undefined) patch.enabled = values.enabled
  if (values.listenPort !== undefined) patch.listenPort = values.listenPort
  if (values.networkInterface !== undefined) patch.networkInterface = values.networkInterface
  if (values.requirePairing !== undefined) auth.requirePairing = values.requirePairing
  if (values.requireApproval !== undefined) auth.requireApproval = values.requireApproval
  if (values.mode !== undefined) auth.mode = values.mode
  if (values.adminPolicy !== undefined) auth.adminPolicy = values.adminPolicy
  if (values.adminProtection !== undefined) auth.adminProtection = values.adminProtection
  if (values.allowLoopback !== undefined) auth.allowLoopback = values.allowLoopback
  if (Object.keys(auth).length > 0) patch.auth = auth
  return patch
}
