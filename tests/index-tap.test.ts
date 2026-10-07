/**
 * Index-patch tests.
 *
 * The injected markup IS the mechanism: DSH's client connection plugin reads
 * `globalThis.__DSH_TRANSPORT__` when it applies (`ownsHost: true` makes the
 * page look like the host's own surface), the mobile shims cover APIs whose
 * absence makes DSH's stream path throw on older engines, and the watchdog is
 * the only thing that can recover a page whose WebSocket never opens after a
 * background resume. The injected scripts are therefore EXECUTED here against a
 * fake environment, because the failures they prevent are otherwise silent.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_COMPAT_MARKER,
  MOBILE_META_MARKER,
  MOBILE_SCROLL_MARKER,
  MOBILE_TURN_RAIL_MARKER,
  SOCKET_WATCHDOG_MARKER,
  TRANSPORT_GLOBAL,
  TURN_RAIL_CARD_ID,
  TURN_RAIL_DIAG_ID,
  TURN_RAIL_STYLE_ID,
  UNLOCK_MARKER,
  injectMobileCompat,
  injectMobileScrollFix,
  injectMobileTurnRail,
  injectSettingsUnlock,
  injectSocketWatchdog,
  mobileCompatScript,
  mobileMetaMarkup,
  mobileScrollFixScript,
  mobileTurnRailScript,
  mobileTurnRailTouchScript,
  registerIndexPatches,
  settingsUnlockScript,
  socketWatchdogScript,
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

/** The executable body of one injected `<script>`. */
function scriptBody(script: string): string {
  expect(script.startsWith('<script>')).toBe(true)
  expect(script.endsWith('</script>')).toBe(true)
  return script.slice('<script>'.length, -'</script>'.length)
}

/** One fake WebSocket instance. */
class FakeSocket {
  readyState = 0
  readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  closeCalls = 0

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
    this.emit('close')
  }
}

/** A fake environment the watchdog can be installed into. */
function watchdogEnv(options: { visibility?: 'visible' | 'hidden' } = {}): {
  self: Record<string, unknown>
  sockets: FakeSocket[]
  reloads: () => number
  visible: () => void
  hidden: () => void
  storage: Map<string, string>
} {
  const sockets: FakeSocket[] = []
  const listeners = new Map<string, ((event: unknown) => void)[]>()
  let state = options.visibility ?? 'visible'
  let reloadCount = 0
  const storage = new Map<string, string>()
  const self: Record<string, unknown> = {
    WebSocket: class {
      constructor(url: string) {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket as unknown as object
      }
    },
    location: { reload: () => { reloadCount += 1 } },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    },
    document: {
      get visibilityState() { return state },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const list = listeners.get(type) ?? []
        list.push(listener)
        listeners.set(type, list)
      },
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
  }
  return {
    self,
    sockets,
    storage,
    reloads: () => reloadCount,
    visible: () => {
      state = 'visible'
      for (const listener of listeners.get('visibilitychange') ?? []) listener({})
    },
    hidden: () => {
      state = 'hidden'
      for (const listener of listeners.get('visibilitychange') ?? []) listener({})
    },
  }
}

/** Install the watchdog script into a fake environment. */
function installWatchdog(env: ReturnType<typeof watchdogEnv>): Record<string, unknown> {
  const patches: Record<string, unknown> = {}
  const body = scriptBody(socketWatchdogScript())
  const factory = new Function('self', 'globalThis', 'document', 'console', body)
  factory(env.self, patches, env.self.document, console)
  return patches
}

describe('settingsUnlockScript', () => {
  it('is one inline script that sets ownsHost through a merge', () => {
    const script = settingsUnlockScript()
    expect(script).toContain(UNLOCK_MARKER)
    expect(script).toContain(`globalThis.${TRANSPORT_GLOBAL}`)
    expect(script).toContain('ownsHost:true')
    // Merge, never replace: a future DSH release may put its own transport
    // facts there, and clobbering them would break the real carrier.
    expect(script).toContain('Object.assign({}')
    // A primitive sitting on the global must not throw or spread into chars.
    expect(script).toContain('typeof t==="object"')
    // Nothing that would close the element early.
    expect(scriptBody(script)).not.toContain('</script>')
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

  it('is idempotent and degrades to a prepend when there is no head', () => {
    const once = injectSettingsUnlock(INDEX)
    expect(injectSettingsUnlock(once)).toBe(once)
    const headless = injectSettingsUnlock('<body>only</body>')
    expect(headless.startsWith('<script>')).toBe(true)
    expect(headless.endsWith('<body>only</body>')).toBe(true)
  })
})

describe('mobileCompatScript', () => {
  /** Build a fake environment for the shim installer (no modern statics). */
  function compatEnv(): {
    self: Record<string, unknown>
    promise: Record<string, unknown>
    patches: Record<string, unknown>
  } {
    class FakeSignal {
      aborted = false
      reason: unknown = undefined
      readonly listeners: ((event: unknown) => void)[] = []
      addEventListener(_type: string, listener: (event: unknown) => void): void {
        this.listeners.push(listener)
      }
      removeEventListener(_type: string, listener: (event: unknown) => void): void {
        const at = this.listeners.indexOf(listener)
        if (at !== -1) this.listeners.splice(at, 1)
      }
    }
    class FakeController {
      readonly signal = new FakeSignal()
      abort(reason?: unknown): void {
        if (this.signal.aborted) return
        this.signal.aborted = true
        this.signal.reason = reason
        for (const listener of [...this.signal.listeners]) listener({ target: this.signal })
      }
    }
    const self: Record<string, unknown> = { AbortSignal: FakeSignal, AbortController: FakeController }
    return { self, promise: {}, patches: {} }
  }

  /** Install the shims into a fake environment. */
  function installShims(env: ReturnType<typeof compatEnv>): void {
    const body = scriptBody(mobileCompatScript())
    const factory = new Function('self', 'globalThis', 'Promise', 'Object', 'Symbol', 'setTimeout', 'console', body)
    factory(env.self, env.patches, env.promise, Object, Symbol, setTimeout, console)
  }

  it('installs only the missing APIs', () => {
    const env = compatEnv()
    installShims(env)
    const Signal = env.self.AbortSignal as { any?: unknown; timeout?: unknown }
    expect(typeof Signal.any).toBe('function')
    expect(typeof Signal.timeout).toBe('function')
    expect(typeof env.promise.withResolvers).toBe('function')
  })

  it('leaves an engine that already has the APIs untouched', () => {
    const env = compatEnv()
    const any = (): string => 'native'
    ;(env.self.AbortSignal as { any?: unknown }).any = any
    const withResolvers = (): string => 'native'
    env.promise.withResolvers = withResolvers
    installShims(env)
    expect((env.self.AbortSignal as { any?: unknown }).any).toBe(any)
    expect(env.promise.withResolvers).toBe(withResolvers)
  })

  it('combines abort reasons from several signals', () => {
    const env = compatEnv()
    installShims(env)
    const Signal = env.self.AbortSignal as { any(signals: unknown[]): { aborted: boolean; reason: unknown } }
    const Controller = env.self.AbortController as new () => {
      signal: unknown
      abort(reason?: unknown): void
    }
    const first = new Controller()
    const second = new Controller()
    const combined = Signal.any([first.signal, second.signal])
    expect(combined.aborted).toBe(false)
    second.abort('because')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('because')
  })
})

describe('injectMobileCompat', () => {
  const INDEX = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<base href="./"></head><body>app</body></html>'

  it('replaces the viewport meta instead of adding a second one, and adds the PWA metas', () => {
    const out = injectMobileCompat(INDEX)
    expect(out.match(/name="viewport"/g)).toHaveLength(1)
    expect(out).toContain('viewport-fit=cover')
    expect(out).toContain(MOBILE_META_MARKER)
    expect(out).toContain('apple-mobile-web-app-capable')
    expect(out).toContain(MOBILE_COMPAT_MARKER)
    // Zoom is deliberately NOT disabled; this plugin's mobile contract is not
    // about removing the user's pinch gesture.
    expect(out).not.toContain('user-scalable=no')
  })

  it('is idempotent and works without a viewport tag', () => {
    const once = injectMobileCompat(INDEX)
    expect(injectMobileCompat(once)).toBe(once)
    const headless = injectMobileCompat('<html><head></head><body>x</body></html>')
    expect(headless).toContain(mobileMetaMarkup().slice(0, 32))
  })
})

describe('socketWatchdogScript', () => {
  it('injects a self-describing script after the head', () => {
    const out = injectSocketWatchdog('<!doctype html><html><head></head><body>x</body></html>')
    expect(out).toContain(SOCKET_WATCHDOG_MARKER)
    expect(scriptBody(socketWatchdogScript())).not.toContain('</script>')
    expect(injectSocketWatchdog(out)).toBe(out)
  })

  it('closes a socket stuck in CONNECTING after the connect timeout', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/one')
      expect(env.sockets).toHaveLength(1)
      vi.advanceTimersByTime(8_100)
      expect(env.sockets[0]?.closeCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reloads while a socket is OPEN', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/open')
      const socket = env.sockets[0] as FakeSocket
      socket.readyState = 1
      socket.emit('open')
      vi.advanceTimersByTime(60_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reloads a page that created no socket at all', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      vi.advanceTimersByTime(120_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads once when a resumed page has no open socket, then backs off', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/stuck')
      const socket = env.sockets[0] as FakeSocket
      socket.readyState = 3 // died while the page was in the background

      env.hidden()
      vi.advanceTimersByTime(30_000)
      env.visible()
      // The resume path waits out its grace period before judging.
      vi.advanceTimersByTime(11_000)
      expect(env.reloads()).toBe(1)
      expect(env.storage.get('dshLanGuardReloads')).toBe('1')

      // Cooldown: the next watchdog ticks must not reload again.
      vi.advanceTimersByTime(15_000)
      expect(env.reloads()).toBe(1)

      // After the cooldown the escalation may try again.
      vi.advanceTimersByTime(30_000)
      expect(env.reloads()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops reloading once the per-tab cap is reached', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      env.storage.set('dshLanGuardReloads', '3')
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/stuck')
      env.hidden()
      vi.advanceTimersByTime(30_000)
      env.visible()
      vi.advanceTimersByTime(200_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload while the page is hidden', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv({ visibility: 'hidden' })
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/hidden')
      vi.advanceTimersByTime(200_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('injectMobileScrollFix', () => {
  const INDEX = '<!doctype html><html><head></head><body>x</body></html>'

  it('injects a deliberately conservative narrow-screen correction', () => {
    const out = injectMobileScrollFix(INDEX)
    expect(out).toContain(MOBILE_SCROLL_MARKER)
    const body = scriptBody(mobileScrollFixScript())
    expect(body).not.toContain('</script>')
    // It must ask these questions before touching anything: is the page as a
    // whole unable to scroll, is this a narrow screen, is this a phone, and is
    // there actually a layer clipping overflowing content?
    expect(body).toContain('pageScrolls()')
    expect(body).toContain('max-width: 1023px')
    expect(body).toContain('iPhone|iPad|iPod|Android')
    expect(body).toContain('clipping()')
    // Diagnostic mode is opt-in per page load and never blocks the UI.
    expect(body).toContain('lgdiag')
    // 0.4.3 strategy: fix the HEIGHT CHAIN (dsh-mobile's approach) instead of
    // patching overflow on a content layer. The container the official code
    // believes in must become the real scroller, or nothing is changed at all.
    expect(body).toContain('min-height')
    expect(body).toContain('100dvh')
    expect(body).toContain('data-conversation-scroll')
    expect(body).toContain('convScrolls')
    // Failure must revert completely (page stays stock).
    expect(body).toContain('removeProperty')
    expect(body).toContain('ineffective -> reverted')
    // Drawer/scrim safety (the 0.4.2 regression).
    expect(body).toContain('overlayOpen')
    expect(body).toContain('aria-modal=true')
    // And it must NOT do the things that caused the reported regressions:
    // Touch interception (decisive phone-side finding 2026-09-28): the official
    // scroll layer IS scrollable, yet fingers cannot drag — fullscreen
    // decorative layers swallow touches on iOS. Let pure containers through.
    expect(body).toContain('touchPassThrough')
    // Both remedies must run BEFORE the "official scroll layer already works"
    // short-circuit: that state IS the "content visible, finger cannot drag"
    // case, so returning first made them unreachable and the runbook's
    // `layers=N` line unprintable (regression guard, 2026-09-29).
    expect(body).toContain('touchPassThrough();if(fixClip())')
    // A long transcript can mount after the official scroller first becomes
    // nominally scrollable. That intermediate state must not end polling before
    // a late overflow:hidden child can be released.
    expect(body).toContain('official scroll layer works; waiting for late clip')
    expect(body).not.toContain('official scroll layer already works");done=true')
    // DSH 0.2.0-rc.1 regression: the official scroller's own content is clipped
    // by an inner overflow:hidden layer — measured on the phone, 21083px of
    // content yielded only a 336px scroll range. Grow that inner layer AND stop
    // it being a scroll container: height:auto alone restores the range but makes
    // the official "back to bottom" slot (a sticky child of that layer, bottom:208px)
    // resolve against the layer's new 21135px bottom and vanish off-screen
    // (measured: button 514→10683); adding overflow:visible brings it back (538).
    expect(body).toContain('clip grow layers=')
    expect(body).toContain('clip grow ineffective -> reverted')
    expect(body).toContain('c.contains(list[i])')
    expect(body).toContain('set(list[i],"height","auto");set(list[i],"overflow","visible")')
    expect(body).toContain('pointer-events","none')
    expect(body).toContain('querySelector("button,input,textarea,select,[contenteditable]")')
    expect(body).not.toContain('overflow-y","auto')
    expect(body).not.toContain('lg-to-bottom')
    expect(body).not.toContain('-webkit-overflow-scrolling')
    expect(body).toContain('pointer-events:none')
    // Idempotent.
    expect(injectMobileScrollFix(out)).toBe(out)
  })

  it('is applied by the registrar only while its switch is on', () => {
    let on = false
    let transform: (html: string) => string = () => INDEX
    registerIndexPatches({
      webServer: { tapIndex: (fn: (html: string) => string) => { transform = fn; return () => {} } },
      switches: {
        settingsUnlock: () => false,
        mobileCompat: () => false,
        socketWatchdog: () => false,
        mobileScrollFix: () => on,
        mobileTurnRail: () => false,
      },
    })
    expect(transform(INDEX)).toBe(INDEX)
    on = true
    expect(transform(INDEX)).toContain(MOBILE_SCROLL_MARKER)
  })
})

/** One element in the fake DOM below. Only what the injected scripts touch. */
class FakeElement {
  readonly style: Record<string, string> = { cssText: '' }
  readonly children: FakeElement[] = []
  readonly attrs: Record<string, string> = {}
  readonly handlers = new Map<string, ((event: unknown) => void)[]>()
  parentNode: FakeElement | null = null
  closestTarget: FakeElement | null = null
  textContent = ''
  className = ''
  type = ''
  focused = false
  pointerMoves = 0
  clicked = 0
  display = 'block'
  left = 343
  top = 355
  width = 28
  height = 52
  scrollTop = 0
  capturedPointer: number | null = null

  constructor(readonly tag: string, readonly id = '') {}

  get tagName(): string {
    return this.tag.toUpperCase()
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child: FakeElement): void {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentNode = null
  }

  getBoundingClientRect(): { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { x: this.left, y: this.top, left: this.left, top: this.top, right: this.left + this.width, bottom: this.top + this.height, width: this.width, height: this.height }
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(listener)
    this.handlers.set(type, list)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter(entry => entry !== listener))
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event)
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }

  focus(): void {
    this.focused = true
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointer = pointerId
  }

  releasePointerCapture(pointerId: number): void {
    if (this.capturedPointer === pointerId) this.capturedPointer = null
  }

  contains(node: unknown): boolean {
    let walk = node as FakeElement | null
    while (walk !== null && walk !== undefined) {
      if (walk === this) return true
      walk = walk.parentNode
    }
    return false
  }

  closest(): FakeElement | null {
    return this.closestTarget
  }

  click(): void {
    this.clicked += 1
    this.dispatch('click', { target: this, stopPropagation() {}, preventDefault() {} })
  }

  dispatchEvent(event: { type?: unknown }): boolean {
    if (event.type === 'pointermove') this.pointerMoves += 1
    if (typeof event.type === 'string') this.dispatch(event.type, event as Record<string, unknown>)
    return true
  }

  /** Descendant lookup for the two selectors the injected code actually uses. */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if ((selector === 'button' || selector === 'button[data-index]') && child.tag === 'button'
          && (selector !== 'button[data-index]' || child.attrs['data-index'] !== undefined)) out.push(child)
        if (selector.includes('tooltip') && child.attrs.role === 'tooltip') out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

/** Options for {@link turnRailEnv}. */
interface TurnRailEnvOptions {
  /** What the width query reports; decides whether the rail override applies. */
  matchMedia?: boolean
  /** What `'(pointer: coarse)'` reports; decides whether the gesture layer installs. */
  coarse?: boolean
  nav?: 'absent' | 'hidden' | 'visible'
  /** The rail's marks, by aria-label. Defaults to three loaded turns. */
  marks?: readonly string[]
  /** Text the official tooltip renders after a mark receives its hover signal. */
  preview?: { prompt: string; reply: string }
  /** Simulate React committing a different official tooltip after a pointer move. */
  previewByMark?: Readonly<Record<string, { prompt: string; reply: string }>>
  /** Delay that simulated React commit; defaults to immediately. */
  previewDelayMs?: number
  /** Make `document.addEventListener` throw, to prove the rail survives it. */
  brokenListeners?: boolean
}

/**
 * A fake page the turn-rail script can be installed into.
 *
 * `nav` is what `document.querySelector(selector)` returns: the real script
 * looks for `nav[aria-label=…]`, so `null` models "no rail mounted yet" (the
 * chat has fewer than two turns) and a `display:none` element models "the rail
 * is there but the override did not win" — the state that must revert.
 *
 * The nav mirrors the real shape — `nav > scroller > marks > button`, plus
 * `nav > [role=tooltip]` — because the touch layer reads the tooltip text and
 * scrolls the first child.
 */
function turnRailEnv(options: TurnRailEnvOptions = {}) {
  const created: FakeElement[] = []
  const head = new FakeElement('head')
  const nav = options.nav === undefined || options.nav === 'absent'
    ? null
    : new FakeElement('nav', '')
  const marks: FakeElement[] = []
  let tooltip: FakeElement | null = null
  if (nav !== null) {
    nav.display = options.nav === 'hidden' ? 'none' : 'block'
    if (options.nav === 'hidden') { nav.width = 0; nav.height = 0 }
    nav.setAttribute('aria-label', '轮次导航')
    nav.left = 401
    nav.top = 355
    nav.width = 28
    nav.height = 52
    const scroller = new FakeElement('div')
    scroller.left = nav.left
    scroller.top = nav.top
    scroller.width = nav.width
    scroller.height = nav.height
    const marksBox = new FakeElement('div')
    for (const label of options.marks ?? ['跳转到第 1 轮', '跳转到第 2 轮', '跳转到第 3 轮']) {
      const mark = new FakeElement('button')
      mark.left = nav.left
      mark.top = nav.top + marks.length * 10
      mark.width = nav.width
      mark.height = 10
      mark.setAttribute('data-index', String(marks.length))
      mark.setAttribute('aria-label', label)
      mark.closestTarget = nav
      marks.push(mark)
      marksBox.appendChild(mark)
    }
    scroller.appendChild(marksBox)
    nav.appendChild(scroller)
    const preview = options.preview ?? { prompt: '预览里的提问', reply: '预览里的回答' }
    tooltip = new FakeElement('div')
    tooltip.setAttribute('role', 'tooltip')
    const prompt = new FakeElement('div')
    prompt.textContent = preview.prompt
    const reply = new FakeElement('div')
    reply.textContent = preview.reply
    tooltip.appendChild(prompt)
    tooltip.appendChild(reply)
    nav.appendChild(tooltip)
    // React owns the real tooltip and may update it after the pointer event has
    // already returned. Model that delayed commit so the mobile layer cannot
    // merely assume two animation frames are always enough.
    for (const mark of marks) {
      mark.addEventListener('pointermove', () => {
        const next = options.previewByMark?.[mark.getAttribute('aria-label') ?? '']
        // React changes markPreview and tooltip contents in the same commit.
        // A mapped mark deliberately commits late to prove the card waits for
        // the official DOM instead of displaying the old turn's text.
        setTimeout(() => {
          for (const candidate of marks) candidate.className = candidate === mark ? 'markPreview' : ''
          if (next !== undefined) {
            prompt.textContent = next.prompt
            reply.textContent = next.reply
          }
        }, next === undefined ? 0 : (options.previewDelayMs ?? 0))
      })
    }
  }
  const documentListeners = new Map<string, ((event: Record<string, unknown>) => void)[]>()
  const doc = {
    head,
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    createElement: (tag: string) => {
      const element = new FakeElement(tag)
      created.push(element)
      return element
    },
    createTextNode: (text: string) => {
      const node = new FakeElement('#text')
      node.textContent = text
      return node
    },
    getElementById: (id: string) => created.find(element => element.id === id) ?? null,
    querySelector: (selector: string) => (selector.includes('轮次导航') || selector.includes('Turn navigation') ? nav : null),
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      if (options.brokenListeners === true) throw new Error('addEventListener is unavailable')
      const list = documentListeners.get(type) ?? []
      list.push(listener)
      documentListeners.set(type, list)
    },
    removeEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter(entry => entry !== listener))
    },
  }
  class FakePointerEvent {
    readonly type: string
    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type
      Object.assign(this, init)
    }
  }
  class FakeEvent extends FakePointerEvent {}
  const self = {
    // Two different questions are asked of matchMedia: the width query decides
    // whether the rail override applies, the pointer query whether the phone
    // gesture layer installs. A fake that answers both with one flag would hide
    // exactly the bugs this file exists to catch.
    matchMedia: (query: string) => ({
      matches: query === '(pointer: coarse)' ? (options.coarse ?? true) : (options.matchMedia ?? true),
    }),
    PointerEvent: FakePointerEvent,
    Event: FakeEvent,
  }
  const patches: Record<string, unknown> = {}
  return {
    doc,
    self,
    patches,
    head,
    created,
    nav,
    marks,
    tooltip,
    /** Push one document-level event at the injected listeners. */
    dispatch: (type: string, event: Record<string, unknown>) => {
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event)
    },
    card: () => created.find(element => element.id === TURN_RAIL_CARD_ID) ?? null,
    cardParts: () => {
      const card = created.find(element => element.id === TURN_RAIL_CARD_ID)
      if (card === undefined) return null
      const [head, body, row] = card.children
      return {
        card,
        title: head?.children[0],
        close: head?.children[1],
        body,
        prev: row?.children[0],
        jump: row?.children[1],
        next: row?.children[2],
      }
    },
    // Only styles still attached to the document count: the revert path
    // detaches the element instead of un-creating it.
    styles: () => created.filter(element => element.tag === 'style' && element.parentNode !== null),
    ledger: () => (patches.__DSH_LAN_GUARD__ ?? {}) as Record<string, unknown>,
  }
}

/**
 * Run the turn-rail script against a fake page.
 *
 * @returns the page's patch ledger, read AFTER the run: the script replaces the
 * `__DSH_LAN_GUARD__` object on every transition (installed → reverted), so a
 * captured reference would go stale.
 */
function installTurnRail(env: ReturnType<typeof turnRailEnv>): Record<string, unknown> {
  const body = scriptBody(mobileTurnRailScript())
  const factory = new Function(
    'self', 'globalThis', 'document', 'console', 'getComputedStyle',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
    body,
  )
  factory(
    env.self, env.patches, env.doc, console,
    (element: FakeElement) => ({ display: element.display }),
    globalThis.setInterval, globalThis.clearInterval,
    globalThis.setTimeout, globalThis.clearTimeout,
    (callback: () => void) => { callback(); return 1 },
  )
  return env.ledger()
}

describe('injectMobileTurnRail', () => {
  const INDEX = '<!doctype html><html><head></head><body>x</body></html>'

  it('injects one scoped, revertible override of DSH’s own container query', () => {
    const out = injectMobileTurnRail(INDEX)
    expect(out).toContain(MOBILE_TURN_RAIL_MARKER)
    const body = scriptBody(mobileTurnRailScript())
    expect(body).not.toContain('</script>')
    // Narrow screens only: a desktop window must keep DSH's own behaviour.
    expect(body).toContain('max-width: 1023px')
    // DSH hides the rail with `@container (max-width: 900px) { .frame{display:none} }`,
    // so the override has to out-specify a class AND stay display-only.
    expect(body).toContain('轮次导航')
    expect(body).toContain('Turn navigation')
    expect(body).toContain('display:block!important;right:4px!important;width:28px!important')
    // Structural fallback for a localised/renamed label; display-only.
    expect(body).toContain('div:has(>div [data-chat-flow])>div>nav{display:block!important}')
    // Self-check and full revert, like every other page patch here.
    expect(body).toContain('getComputedStyle')
    expect(body).toContain('removeChild')
    expect(body).toContain('reverted')
    expect(body).toContain(TURN_RAIL_STYLE_ID)
    // Diagnostics stay opt-in and must not collide with the scroll fix panel.
    expect(body).toContain('lgdiag')
    expect(body).toContain(TURN_RAIL_DIAG_ID)
    expect(TURN_RAIL_DIAG_ID).not.toBe('lgsc')
    // The rail half stays a stylesheet: it never patches overflow or invents a
    // second scroll container.
    expect(body).not.toContain('overflow-y","auto')
    // The phone half: DSH's own preview is a HOVER affordance (onPointerMove /
    // onFocus), which a touch screen can never reach, so the patch adds a hold
    // gesture that reads the official tooltip instead of reimplementing it.
    expect(body).toContain(TURN_RAIL_CARD_ID)
    expect(body).toContain('(pointer: coarse)')
    // Scrubbing needs continuous pointermove after a hold. The layer owns
    // touch-action and manually preserves quick-drag rail scrolling.
    expect(body).toContain('touch-action:none')
    expect(body).toContain('turn scrub start')
    expect(body).toContain('button[data-index]')
    expect(body).toContain('autoScroll')
    // The hovered tick must be VISIBLE while scrubbing: the official preview
    // style is a 0.9-scale grey hairline, invisible under a finger.
    // A native drag begun on the rail can end as a file drop, which DSH answers
    // with its upload affordance; the rail must not be a drag source at all.
    expect(body).toContain('-webkit-user-drag:none')
    // The subtree must carry touch-action too, and the phone must stop treating a
    // downward drag at the top of the page as a reload.
    // The escaped selector keeps its quotes, so assert on the rule body only.
    expect(body).toContain('*{touch-action:none!important')
    expect(body).toContain('overscroll-behavior-y:none')
    expect(body).toContain('blockTouch')
    expect(body).toContain('blockDrag')
    expect(body).toContain('_markP')
    expect(body).toContain('--dsw-alias-state-business-primary')
    expect(body).toContain('-webkit-touch-callout:none')
    expect(body).toContain('320')
    expect(body).toContain('pointerdown')
    expect(body).toContain('pointercancel')
    expect(body).toContain('[role="tooltip"]')
    expect(body).toContain('aria-label')
    expect(body).toContain('swallowNextClick')
    // Idempotent.
    expect(injectMobileTurnRail(out)).toBe(out)
  })

  it('is applied by the registrar only while its switch is on', () => {
    let on = false
    let transform: (html: string) => string = () => INDEX
    registerIndexPatches({
      webServer: { tapIndex: (fn: (html: string) => string) => { transform = fn; return () => {} } },
      switches: {
        settingsUnlock: () => false,
        mobileCompat: () => false,
        socketWatchdog: () => false,
        mobileScrollFix: () => false,
        mobileTurnRail: () => on,
      },
    })
    expect(transform(INDEX)).toBe(INDEX)
    on = true
    expect(transform(INDEX)).toContain(MOBILE_TURN_RAIL_MARKER)
  })

  it('installs the style and records the patch when the rail comes up', () => {
    const env = turnRailEnv({ nav: 'visible' })
    const patches = installTurnRail(env)
    expect(env.styles().map(style => style.id)).toEqual([TURN_RAIL_STYLE_ID])
    expect(env.head.children).toHaveLength(1)
    expect(patches.mobileTurnRail).toBe(true)
  })

  it('keeps the style when no rail is mounted yet, and reports it', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'absent' })
      const patches = installTurnRail(env)
      vi.advanceTimersByTime(1500 * 12)
      // A session with fewer than two turns has no rail at all; the style must
      // survive for the next session instead of being thrown away.
      expect(env.styles()).toHaveLength(1)
      expect(patches.mobileTurnRail).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reverts completely when the override does not win', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'hidden' })
      installTurnRail(env)
      expect(env.styles()).toHaveLength(1)
      vi.advanceTimersByTime(1500 * 3)
      expect(env.styles()).toHaveLength(0)
      expect(env.head.children).toHaveLength(0)
      expect(env.ledger().mobileTurnRail).toBe('reverted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing on a wide page, where DSH’s own rule is not what hides it', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ matchMedia: false, nav: 'hidden' })
      const patches = installTurnRail(env)
      vi.advanceTimersByTime(1500 * 12)
      expect(env.styles()).toHaveLength(1)
      expect(patches.mobileTurnRail).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a readable card when a mark is held, and reads the official tooltip', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      expect(env.card()).toBeNull()

      // Hold the SECOND mark. Nothing may happen before the hold threshold.
      env.dispatch('pointerdown', { target: env.marks[1], clientY: 5 })
      vi.advanceTimersByTime(300)
      expect(env.card()).toBeNull()

      // React's markPreview commit and the tooltip watcher may land after the
      // hold timer itself; wait past one observer fallback interval.
      vi.advanceTimersByTime(120)
      const parts = env.cardParts()
      expect(parts?.card.style.display).toBe('block')
      // The card stays in the official rail's containing block, not a
      // body-level fixed layer whose viewport coordinates WebKit may reinterpret.
      expect(parts?.card.parentNode).toBe(env.nav)
      // The mobile layer sends the same pointermove signal the desktop hover
      // handler consumes; it must NOT focus the right-edge button (iOS Chrome
      // can scroll a focused button into view, shifting the visual viewport).
      expect(env.marks[1]?.pointerMoves).toBeGreaterThan(0)
      expect(env.marks[1]?.focused).toBe(false)
      expect(parts?.title?.textContent).toBe('预览里的提问')
      expect(parts?.body?.textContent).toBe('预览里的回答')
      expect(parts?.jump?.textContent).toBe('跳转到第 2 轮')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a native drag or selection that starts on the rail, and only there', () => {
    // DSH's attachment view listens document-wide for drags carrying Files and
    // answers them with its upload affordance, so a drag that begins on the rail
    // must never become one. Selection and dragging elsewhere are untouched.
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      const outside = new FakeElement('p')
      const seen: string[] = []
      // Label by provenance, not by identity with one particular mark: the rail
      // case is exercised for more than one tick.
      const drag = (target: FakeElement) => ({
        target,
        preventDefault: () => { seen.push(target === outside ? 'outside-prevented' : 'rail-prevented') },
        stopPropagation: () => { seen.push(target === outside ? 'outside-stopped' : 'rail-stopped') },
      })

      env.dispatch('dragstart', drag(env.marks[0] as FakeElement))
      expect(seen).toEqual(['rail-prevented', 'rail-stopped'])

      // A drag that starts in the transcript must still reach the app.
      env.dispatch('dragstart', drag(outside))
      expect(seen).toHaveLength(2)

      env.dispatch('selectstart', drag(env.marks[1] as FakeElement))
      expect(seen.slice(2)).toEqual(['rail-prevented', 'rail-stopped'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('quick-dragging the rail scrolls it manually and never opens a card', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      const scroller = env.nav?.firstElementChild
      const stopped: string[] = []
      const y = env.marks[1]?.top ?? 365
      env.dispatch('pointerdown', { target: env.marks[1], clientY: y, pointerId: 7 })
      // Move before 320ms: it is an ordinary rail scroll, not a scrub.
      env.dispatch('pointermove', {
        target: env.marks[1], clientY: y - 36, pointerId: 7,
        preventDefault: () => { stopped.push('prevented') },
      })
      vi.advanceTimersByTime(2000)
      expect(env.card()).toBeNull()
      expect(scroller?.scrollTop).toBe(36)
      expect(stopped).toEqual(['prevented'])
      // And the pointerup that ends a cancelled hold must not arm anything.
      env.dispatch('pointerup', { target: env.marks[1], clientY: y - 36, pointerId: 7 })
      vi.advanceTimersByTime(2000)
      expect(env.card()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses page scrolling for a gesture that started on the rail', () => {
    // touch-action on the nav was not enough on WebKit: the finger lands on a
    // mark (touch-action:auto, and official CSS sets none inside the rail), so
    // the browser could still take the vertical drag after its slop and the
    // overscroll then fired pull-to-refresh mid-scrub. The subtree rule plus a
    // non-passive touchmove refusal is what keeps the gesture ours.
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      const outside = new FakeElement('p')
      const prevented: string[] = []
      const move = (target: FakeElement, touches = 1) => ({
        target,
        touches: Array.from({ length: touches }, () => ({})),
        preventDefault: () => { prevented.push(target === outside ? 'outside' : 'rail') },
      })

      // Nothing is armed yet: the layer must not interfere with the page.
      env.dispatch('touchmove', move(env.marks[0] as FakeElement))
      expect(prevented).toEqual([])

      env.dispatch('pointerdown', { target: env.marks[0], clientY: 355, pointerId: 51 })
      env.dispatch('touchmove', move(env.marks[0] as FakeElement))
      expect(prevented).toEqual(['rail'])

      // A touch elsewhere, or a second finger (pinch), is never touched.
      env.dispatch('touchmove', move(outside))
      env.dispatch('touchmove', move(env.marks[1] as FakeElement, 2))
      expect(prevented).toEqual(['rail'])

      // After the gesture ends the page is free again.
      env.dispatch('pointerup', { target: env.marks[0], clientY: 355, pointerId: 51 })
      vi.advanceTimersByTime(600)
      env.dispatch('touchmove', move(env.marks[0] as FakeElement))
      expect(prevented).toEqual(['rail'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('scrubs through turn summaries after the hold without navigating', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      const first = env.marks[0]!
      const third = env.marks[2]!
      env.dispatch('pointerdown', { target: first, clientY: first.top + 5, pointerId: 19 })
      vi.advanceTimersByTime(400)
      expect(env.cardParts()?.jump?.textContent).toBe('跳转到第 1 轮')
      expect(first.capturedPointer).toBe(19)

      const prevented: string[] = []
      env.dispatch('pointermove', {
        target: first, clientY: third.top + 5, pointerId: 19,
        preventDefault: () => { prevented.push('move') },
      })
      // The card changes live as the finger crosses marks; no mark click occurs.
      expect(third.pointerMoves).toBeGreaterThan(0)
      expect(env.cardParts()?.jump?.textContent).toBe('跳转到第 3 轮')
      expect(third.clicked).toBe(0)
      expect(prevented).toEqual(['move'])

      // Releasing pins the preview for reading and suppresses only the follow-up click.
      env.dispatch('pointerup', { target: third, clientY: third.top + 5, pointerId: 19 })
      expect(env.cardParts()?.card.style.display).toBe('block')
      expect(first.capturedPointer).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the steppers pick the exact turn, so a 10px tick is not the target', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      env.dispatch('pointerdown', { target: env.marks[0], clientY: 5 })
      vi.advanceTimersByTime(400)
      expect(env.cardParts()?.jump?.textContent).toBe('跳转到第 1 轮')

      env.cardParts()?.next?.click()
      expect(env.marks[1]?.pointerMoves).toBeGreaterThan(0)
      expect(env.cardParts()?.jump?.textContent).toBe('跳转到第 2 轮')

      env.cardParts()?.prev?.click()
      expect(env.cardParts()?.jump?.textContent).toBe('跳转到第 1 轮')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes the floating prompt and reply when React commits a delayed tooltip', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({
        nav: 'visible',
        preview: { prompt: '第一轮问题', reply: '第一轮摘要' },
        previewByMark: {
          '跳转到第 2 轮': { prompt: '第二轮问题', reply: '第二轮摘要' },
        },
        // This is deliberately longer than the old double-rAF assumption.
        previewDelayMs: 150,
      })
      installTurnRail(env)
      const first = env.marks[0]!
      const second = env.marks[1]!
      env.dispatch('pointerdown', { target: first, clientY: first.top + 5, pointerId: 61 })
      vi.advanceTimersByTime(400)
      expect(env.cardParts()?.title?.textContent).toBe('第一轮问题')
      expect(env.cardParts()?.body?.textContent).toBe('第一轮摘要')

      env.dispatch('pointermove', {
        target: first, clientY: second.top + 5, pointerId: 61, preventDefault() {},
      })
      // The blue jump button is immediate, but stale prompt/reply must not be
      // presented as if they belonged to turn 2 while React is still committing.
      expect(env.cardParts()?.jump?.textContent).toBe('跳转到第 2 轮')
      expect(env.cardParts()?.title?.textContent).toBe('跳转到第 2 轮')
      expect(env.cardParts()?.body?.style.display).toBe('none')

      vi.advanceTimersByTime(220)
      expect(env.cardParts()?.title?.textContent).toBe('第二轮问题')
      expect(env.cardParts()?.body?.textContent).toBe('第二轮摘要')
      expect(env.cardParts()?.body?.style.display).toBe('block')
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-scrolls the virtual rail while a held finger rests at its edge', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible', marks: Array.from({ length: 12 }, (_, i) => `跳转到第 ${String(i + 1)} 轮`) })
      installTurnRail(env)
      const first = env.marks[0]!
      const scroller = env.nav?.firstElementChild
      env.dispatch('pointerdown', { target: first, clientY: first.top + 5, pointerId: 31 })
      vi.advanceTimersByTime(400)
      const edgeY = (env.nav?.top ?? 355) + (env.nav?.height ?? 52) - 2
      env.dispatch('pointermove', { target: first, clientY: edgeY, pointerId: 31, preventDefault() {} })
      vi.advanceTimersByTime(64)
      expect(scroller?.scrollTop).toBeGreaterThan(0)
      env.dispatch('pointerup', { target: first, clientY: edgeY, pointerId: 31 })
      const stoppedAt = scroller?.scrollTop
      vi.advanceTimersByTime(64)
      expect(scroller?.scrollTop).toBe(stoppedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows the click a held touch emits, so holding never navigates', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      env.dispatch('pointerdown', { target: env.marks[1], clientY: 5 })
      vi.advanceTimersByTime(400)
      // A held touch emits its compatibility click only after pointerup.
      env.dispatch('pointerup', { target: env.marks[1], clientY: 5 })
      const parts = env.cardParts()
      const stopped: string[] = []
      const click = (target: FakeElement) => ({
        target,
        stopPropagation: () => { stopped.push(target === parts?.jump ? 'card' : 'mark') },
        preventDefault: () => {},
      })

      // The card's own button must keep working...
      env.dispatch('click', click(parts?.jump as FakeElement))
      expect(stopped).toEqual([])
      // ...while the click the browser still fires for the held touch must not
      // reach the official navigate handler.
      env.dispatch('click', click(env.marks[1] as FakeElement))
      expect(stopped).toEqual(['mark'])
      // And the guard is one-shot: it does not keep eating later taps.
      env.dispatch('click', click(env.marks[2] as FakeElement))
      expect(stopped).toEqual(['mark'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows the trailing click even when the system cancels the gesture', () => {
    // iOS fires pointercancel when it takes the gesture over (native selection or
    // drag). The click that follows still belongs to our gesture and must not
    // reach whatever sits under the finger.
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      env.dispatch('pointerdown', { target: env.marks[1], clientY: env.marks[1]?.top ?? 365, pointerId: 41 })
      vi.advanceTimersByTime(400)
      env.dispatch('pointermove', {
        target: env.marks[1], clientY: (env.marks[2]?.top ?? 385) + 5, pointerId: 41, preventDefault() {},
      })
      env.dispatch('pointercancel', { target: env.marks[1], pointerId: 41 })

      const stopped: string[] = []
      env.dispatch('click', {
        target: env.marks[1] as FakeElement,
        stopPropagation: () => { stopped.push('swallowed') },
        preventDefault: () => {},
      })
      expect(stopped).toEqual(['swallowed'])

      // A plain tap has no drag state to protect, so it must never be swallowed.
      env.dispatch('pointerdown', { target: env.marks[1], clientY: env.marks[1]?.top ?? 365, pointerId: 42 })
      vi.advanceTimersByTime(100)
      env.dispatch('pointercancel', { target: env.marks[1], pointerId: 42 })
      env.dispatch('click', {
        target: env.marks[1] as FakeElement,
        stopPropagation: () => { stopped.push('tap-swallowed') },
        preventDefault: () => {},
      })
      expect(stopped).toEqual(['swallowed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('jumps through the official handler, then dismisses itself', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible' })
      installTurnRail(env)
      env.dispatch('pointerdown', { target: env.marks[2], clientY: 5 })
      vi.advanceTimersByTime(400)
      env.cardParts()?.jump?.click()
      // Clicking the mark is what a tap does, so the official load-and-jump /
      // navigate path runs unchanged.
      expect(env.marks[2]?.clicked).toBe(1)
      expect(env.cardParts()?.card.style.display).toBe('none')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still installs the rail when the touch layer cannot set itself up', () => {
    vi.useFakeTimers()
    try {
      const env = turnRailEnv({ nav: 'visible', brokenListeners: true })
      const patches = installTurnRail(env)
      expect(env.styles()).toHaveLength(1)
      expect(patches.mobileTurnRail).toBe(true)
      expect(env.card()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('registerIndexPatches', () => {
  const INDEX = '<!doctype html><html><head><base href="./"></head><body>app</body></html>'

  it('degrades to a warning when the host exposes no tapIndex', () => {
    const { logger, warnings } = recordingLogger()
    const switches = {
      settingsUnlock: () => true, mobileCompat: () => true, socketWatchdog: () => true,
      mobileScrollFix: () => true, mobileTurnRail: () => false,
    }
    expect(registerIndexPatches({ webServer: {}, switches, logger })).toBeUndefined()
    expect(registerIndexPatches({ webServer: undefined, switches, logger })).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })

  it('applies each patch only while its switch is on, and reads the switch per render', () => {
    let settingsUnlock = false
    let mobileCompat = false
    let socketWatchdog = false
    let transform: (html: string) => string = () => INDEX
    const webServer = { tapIndex: (fn: (html: string) => string) => { transform = fn; return () => {} } }
    registerIndexPatches({
      webServer,
      switches: {
        settingsUnlock: () => settingsUnlock,
        mobileCompat: () => mobileCompat,
        socketWatchdog: () => socketWatchdog,
        mobileScrollFix: () => false,
        mobileTurnRail: () => false,
      },
    })

    expect(transform(INDEX)).toBe(INDEX)

    settingsUnlock = true
    expect(transform(INDEX)).toContain(UNLOCK_MARKER)
    expect(transform(INDEX)).not.toContain(MOBILE_COMPAT_MARKER)

    mobileCompat = true
    socketWatchdog = true
    const all = transform(INDEX)
    expect(all).toContain(UNLOCK_MARKER)
    expect(all).toContain(MOBILE_COMPAT_MARKER)
    expect(all).toContain(SOCKET_WATCHDOG_MARKER)
    // Idempotent even when all three are on and the same document renders twice.
    expect(transform(all)).toBe(all)
  })

  it('disposes the tap', () => {
    let disposed = false
    const webServer = { tapIndex: () => () => { disposed = true } }
    const dispose = registerIndexPatches({
      webServer,
      switches: {
        settingsUnlock: () => true, mobileCompat: () => true, socketWatchdog: () => true,
        mobileScrollFix: () => true, mobileTurnRail: () => false,
      },
    })
    dispose?.()
    expect(disposed).toBe(true)
  })
})
