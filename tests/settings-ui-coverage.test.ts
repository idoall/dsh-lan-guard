/**
 * Settings-page coverage guard.
 *
 * The host whitelists a switch, the README promises it is editable in the page,
 * and the page... forgets a widget. That is exactly how `adminPolicy` stayed
 * uneditable for two releases while being the load-bearing switch for remote
 * workspace access: `POLICY_CHOICES` was defined in the client and never
 * rendered, so the only way to leave the default `local_only` was to hand-edit
 * the profile patch (reported 2026-09-26).
 *
 * This test reads the client source and asserts every switch the host accepts
 * at runtime has a write call in the page. It is deliberately a source-level
 * check: rendering the React tree needs a DOM and a React copy this package
 * does not ship, and the failure it guards against is "the control is absent",
 * not "the control is drawn wrong".
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PREFERENCE_KEYS } from '../src/store/preferences.ts'

/**
 * Switches the page must NOT expose.
 *
 * `enabled` is the plugin master switch: `config.ts` documents it as a
 * startup-safety field the listener reads statically, so it is persisted
 * through the settings service but only takes effect on the next start.
 */
const STARTUP_ONLY: readonly string[] = ['enabled']

describe('settings page coverage', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')

  it('writes every runtime switch the host accepts', () => {
    const missing = PREFERENCE_KEYS
      .filter(key => !STARTUP_ONLY.includes(key))
      .filter(key => !source.includes(`preferences: { ${key}:`))
    expect(missing).toEqual([])
  })

  it('exposes the authority switches that gate the remote workspace picker', () => {
    // These three decide whether a LAN device may browse directories at all;
    // a regression here makes the picker unusable with no visible cause.
    for (const key of ['adminPolicy', 'adminProtection', 'allowLoopback']) {
      expect(source).toContain(`preferences: { ${key}:`)
    }
  })

  it('drives the toast countdown bar from the same constant as the timer', () => {
    // Two independent durations would drift, and a bar that outlives its toast
    // (or vanishes early) is worse than no bar at all.
    expect(source).toMatch(/const TOAST_MS = \d+/)
    expect(source).toContain('}, TOAST_MS)')
    expect(source).toContain('animationDuration: `${String(TOAST_MS)}ms`')
  })

  it('clears the previous toast timer before arming a new one', () => {
    // Without this a second save inside the window is dismissed by the FIRST
    // timer, so the confirmation flashes for a few hundred milliseconds.
    const flash = source.slice(source.indexOf('const flash = useCallback'))
    expect(flash.slice(0, 400)).toContain('clearNoticeTimer()')
  })

  it('never paints a status surface with a hover tint', () => {
    // --dsw-alias-interactive-bg-hover-danger resolves to an 8-digit colour
    // whose alpha byte is 0x0d (5%): a wash over whatever is behind it, not a
    // background. Danger surfaces mix the semantic colour into bg-layer-1.
    expect(source).not.toContain('background:var(--dsw-alias-interactive-bg-hover-danger')
    expect(source).toContain('color-mix(in srgb, var(--dsw-alias-state-error-primary')
  })

  it('keeps every status surface’s TEXT on the high-contrast label token', () => {
    // Measured against DSH 0.1.7 in both themes: semantic-on-tint is 3.60:1
    // (light) and 4.39:1 (dark) — below AA for text; label-primary on the same
    // surfaces is 16.04:1 and 9.79:1. The semantic colour belongs on the icon
    // and border, where the bar is 3:1.
    const rules = [
      '.lg-bar.info{', '.lg-bar.warn{', '.lg-bar.danger{',
      '.lg-toast.info{', '.lg-toast.danger{', '.lg-chip.wait{',
    ]
    for (const rule of rules) {
      const start = source.indexOf(rule)
      expect(start, `${rule} is missing`).toBeGreaterThanOrEqual(0)
      expect(source.slice(start, source.indexOf('}', start)), rule)
        .toContain('color:var(--dsw-alias-label-primary')
    }
  })
})
