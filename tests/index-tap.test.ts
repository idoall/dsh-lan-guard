/**
 * Remote settings-page unlock tests.
 *
 * The injected markup is the WHOLE mechanism: DSH's client connection plugin
 * reads `globalThis.__DSH_TRANSPORT__` when it applies, and `ownsHost: true` is
 * what makes it treat the page as the host's own surface. These tests pin the
 * markup, its placement and the degradation path, because a silent change here
 * would look exactly like the upstream bug it exists to fix.
 */
import { describe, expect, it } from 'vitest'
import {
  TRANSPORT_GLOBAL,
  UNLOCK_MARKER,
  injectSettingsUnlock,
  registerSettingsUnlock,
  settingsUnlockScript,
} from '../src/settings/index-tap.ts'
import type { LanGuardLogger } from '../src/log.ts'

/** A logger that records what it was told. */
function recordingLogger(): { logger: LanGuardLogger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      info() {},
      debug() {},
      warn(message: string) { warnings.push(message) },
    },
  }
}

describe('settingsUnlockScript', () => {
  it('is one inline script that sets ownsHost through a merge', () => {
    const script = settingsUnlockScript()
    expect(script.startsWith('<script>')).toBe(true)
    expect(script.endsWith('</script>')).toBe(true)
    expect(script).toContain(UNLOCK_MARKER)
    expect(script).toContain(`globalThis.${TRANSPORT_GLOBAL}`)
    expect(script).toContain('ownsHost:true')
    // Merge, never replace: a future DSH release may put its own transport
    // facts there, and clobbering them would break the real carrier.
    expect(script).toContain('Object.assign({}')
    // A primitive sitting on the global must not throw or spread into chars.
    expect(script).toContain('typeof t==="object"')
    // Nothing that would close the element early.
    expect(script.slice(8, -9)).not.toContain('</script>')
  })
})

describe('injectSettingsUnlock', () => {
  const INDEX = '<!doctype html><html><head><base href="./"></head><body>app</body></html>'

  it('inserts the script immediately after the opening head tag', () => {
    const out = injectSettingsUnlock(INDEX)
    const headEnd = out.indexOf('>', out.indexOf('<head')) + 1
    expect(out.slice(headEnd, headEnd + 8)).toBe('<script>')
    expect(out).toContain('<base href="./">')
    expect(out).toContain('<body>app</body>')
  })

  it('handles a head tag with attributes, and case-insensitively', () => {
    const out = injectSettingsUnlock('<html><HEAD lang="zh-CN"><title>t</title></HEAD></html>')
    expect(out.indexOf(UNLOCK_MARKER)).toBeLessThan(out.indexOf('<title>'))
  })

  it('prepends when the document has no head at all', () => {
    const out = injectSettingsUnlock('<body>bare</body>')
    expect(out.startsWith('<script>')).toBe(true)
    expect(out.endsWith('<body>bare</body>')).toBe(true)
  })

  it('is idempotent', () => {
    const once = injectSettingsUnlock(INDEX)
    expect(injectSettingsUnlock(once)).toBe(once)
  })
})

describe('registerSettingsUnlock', () => {
  it('degrades to a warning when the host exposes no index tap', () => {
    const { logger, warnings } = recordingLogger()
    expect(registerSettingsUnlock({ webServer: {}, enabled: () => true, logger })).toBeUndefined()
    expect(registerSettingsUnlock({ webServer: undefined, enabled: () => true, logger })).toBeUndefined()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/tapIndex/)
  })

  it('reads the live switch on every render, so a toggle needs only a refresh', () => {
    let enabled = false
    const transforms: ((html: string) => string)[] = []
    let disposed = 0
    const webServer = {
      tapIndex(transform: (html: string) => string) {
        transforms.push(transform)
        return () => { disposed += 1 }
      },
    }
    const dispose = registerSettingsUnlock({ webServer, enabled: () => enabled })
    expect(dispose).toBeTypeOf('function')
    expect(transforms).toHaveLength(1)

    const index = '<html><head></head><body></body></html>'
    expect(transforms[0]?.(index)).toBe(index)
    enabled = true
    expect(transforms[0]?.(index)).toContain(UNLOCK_MARKER)
    enabled = false
    expect(transforms[0]?.(index)).toBe(index)

    dispose?.()
    expect(disposed).toBe(1)
  })

  it('calls tapIndex on the service itself', () => {
    const seen: unknown[] = []
    const webServer = {
      marker: 'self',
      tapIndex(this: { marker: string }, transform: (html: string) => string) {
        seen.push(this.marker)
        return () => { void transform }
      },
    }
    registerSettingsUnlock({ webServer, enabled: () => true })
    expect(seen).toEqual(['self'])
  })
})
