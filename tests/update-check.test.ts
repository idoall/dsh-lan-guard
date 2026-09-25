/**
 * Update detection tests (SPEC F8).
 *
 * The promises that matter: the comparison is correct (including prereleases),
 * the lookup is cached and forceable, and a failure is REPORTED — never thrown,
 * because being offline must not disturb the gate or the proxy.
 */
import { describe, expect, it } from 'vitest'
import { compareVersions, isNewer, parseVersion, UpdateChecker } from '../src/update-check.ts'

/** A fetch stub that returns one registry document. */
function stubFetch(version: string, ok = true): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => (ok ? { version } : {}),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('version comparison', () => {
  it('parses plain and prerelease versions', () => {
    expect(parseVersion('0.1.1')).toEqual({ major: 0, minor: 1, patch: 1, prerelease: [] })
    expect(parseVersion('v0.1.2-rc.1')?.prerelease).toEqual(['rc', '1'])
    expect(parseVersion('nope')).toBeUndefined()
  })

  it('orders releases correctly', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1)
  })

  it('ranks a prerelease below its release', () => {
    expect(compareVersions('0.1.2-rc.1', '0.1.2')).toBe(-1)
    expect(compareVersions('0.1.2', '0.1.2-rc.1')).toBe(1)
    expect(compareVersions('0.1.2-rc.2', '0.1.2-rc.1')).toBe(1)
    expect(isNewer('0.1.2-rc.1', '0.1.1')).toBe(true)
  })

  it('treats an unparsable version as equal (never claims an update)', () => {
    expect(isNewer('wat', '0.1.1')).toBe(false)
  })
})

describe('UpdateChecker', () => {
  it('reports an available update', async () => {
    const { fetchImpl } = stubFetch('0.2.0')
    const checker = new UpdateChecker({ currentVersion: '0.1.1', fetchImpl, now: () => 1_000 })
    const status = await checker.check()
    expect(status).toMatchObject({ current: '0.1.1', latest: '0.2.0', hasUpdate: true, error: null })
  })

  it('reports being up to date', async () => {
    const { fetchImpl } = stubFetch('0.1.1')
    const checker = new UpdateChecker({ currentVersion: '0.1.1', fetchImpl })
    expect((await checker.check()).hasUpdate).toBe(false)
  })

  it('caches within the TTL and honours force', async () => {
    const { fetchImpl, calls } = stubFetch('0.2.0')
    let now = 0
    const checker = new UpdateChecker({ currentVersion: '0.1.1', fetchImpl, now: () => now, ttlMs: 1_000 })
    await checker.check()
    await checker.check()
    expect(calls).toHaveLength(1)
    now = 2_000
    await checker.check()
    expect(calls).toHaveLength(2)
    await checker.check({ force: true })
    expect(calls).toHaveLength(3)
  })

  it('reports a failure instead of throwing', async () => {
    const { fetchImpl } = stubFetch('', false)
    const checker = new UpdateChecker({ currentVersion: '0.1.1', fetchImpl })
    const status = await checker.check()
    expect(status.error).toBe('registry_unavailable')
    expect(status.hasUpdate).toBe(false)
    expect(status.latest).toBeNull()
  })

  it('survives a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const checker = new UpdateChecker({ currentVersion: '0.1.1', fetchImpl })
    expect((await checker.check()).error).toBe('registry_unavailable')
  })
})
