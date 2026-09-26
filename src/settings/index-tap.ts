/**
 * dsh-lan-guard — the remote settings-page unlock.
 *
 * DSH decides whether the OFFICIAL settings surface may read or write anything
 * by asking whether the PAGE is loopback. `@deepseek-ai/dsh-client-ui-settings`
 * computes `persistence = ctx.remote.$host.isLoopback ? "host" : "memory"`, and
 * `isLoopback` is derived by the connection client from
 * `transport?.ownsHost === true || pageLocation === undefined ||
 * isLoopbackHostname(pageLocation.hostname)`.
 *
 * A browser that reached this machine through the LAN gateway has a
 * non-loopback `location`, so the mirror stays `unavailable` forever and
 * Settings → Models reports "settings are unavailable in this browser"
 * (reported 2026-09-26). The reverse proxy cannot fix that: the decision reads
 * the VISITOR's own address bar, never a request header.
 *
 * What this machine CAN do is put the one global DSH's connection client reads
 * into the served index, before that client plugin applies:
 *
 *     globalThis.__DSH_TRANSPORT__ = { ...existing, ownsHost: true }
 *
 * `ownsHost` is exactly the flag DSH's own desktop shell sets, so the page is
 * treated as the host's own surface. Merging (never replacing) keeps any value
 * a future DSH release writes there, and the two other readers of that global
 * are unaffected because both fall back the same way without a
 * `streamBaseUrl`: the API gateway's stream mux uses `document.baseURI` and the
 * account sign-in uses `window.location.origin`.
 *
 * The tap is applied by DSH's web server to index.html ONLY (`renderIndex` is
 * the sole caller of `applyIndexTaps`), never to another static file, and it
 * runs BEFORE compression — so no response body has to be buffered or rewritten
 * on the proxy path.
 *
 * This is a UI compatibility patch, not a transport privilege: with the proxy's
 * `host` rewrite the settings RPC is already reachable for any request that
 * passes the gate (reads are redacted by DSH; writes are bounded by this
 * plugin's gate and admin policy). It removes the upstream's "pretend the
 * surface does not exist" state.
 */
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'

/** The page global DSH's connection client reads its transport facts from. */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/**
 * Marker proving this file already injected the script.
 *
 * A tap runs once per index response, so this is a cheap idempotency guard for
 * a second registration or a re-render of an already-transformed body.
 */
export const UNLOCK_MARKER = '/*dsh-lan-guard:settings-unlock*/'

/** The subset of DSH's `webServer` service this module needs. */
export interface IndexTapLike {
  tapIndex(transform: (html: string) => string): () => void
}

/**
 * The exact head markup that makes the page look like the host's own surface.
 *
 * Written as ES5 with `Object.assign` so it cannot throw on a primitive or a
 * hostile value already sitting on the global, and it never overwrites a
 * property DSH itself put there.
 *
 * @returns one inline `<script>` element.
 */
export function settingsUnlockScript(): string {
  return `<script>${UNLOCK_MARKER}(function(){var t=globalThis.${TRANSPORT_GLOBAL};`
    + `globalThis.${TRANSPORT_GLOBAL}=Object.assign({},t!==null&&typeof t==="object"?t:{},{ownsHost:true});`
    + '})()</script>'
}

/**
 * Insert the unlock script into one index document.
 *
 * The script goes immediately after the opening `<head>` tag — the same
 * placement DSH uses for its own injected globals — and is prepended when the
 * document has no head at all. A document that already carries
 * {@link UNLOCK_MARKER} is returned untouched.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the script inserted.
 */
export function injectSettingsUnlock(html: string): string {
  if (html.includes(UNLOCK_MARKER)) return html
  const markup = settingsUnlockScript()
  const open = /<head(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${markup}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/**
 * Install the index tap, when the host exposes one.
 *
 * `enabled` is read on EVERY index render rather than captured, so flipping the
 * switch needs only a page refresh — never a restart.
 *
 * @param options.webServer - DSH's web server service (or a stub).
 * @param options.enabled - the live `settingsUnlock` switch.
 * @param options.logger - logger; a missing seam is a warning, not a failure.
 * @returns the disposer removing the tap, or `undefined` when unsupported.
 */
export function registerSettingsUnlock(options: {
  webServer?: { tapIndex?: unknown } | undefined
  enabled: () => boolean
  logger?: LanGuardLogger
}): (() => void) | undefined {
  const logger = options.logger ?? noopLogger
  const tapIndex = options.webServer?.tapIndex
  if (typeof tapIndex !== 'function') {
    // An older or narrower host: degrade to today's behaviour (the official
    // settings page stays loopback-only) instead of failing the whole plugin.
    logger.warn('webServer.tapIndex is unavailable; the remote settings-page unlock was not installed')
    return undefined
  }
  const tap = tapIndex as (transform: (html: string) => string) => () => void
  return tap.call(options.webServer, html => (options.enabled() ? injectSettingsUnlock(html) : html))
}
