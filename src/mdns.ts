/**
 * dsh-lan-guard — optional mDNS/DNS-SD advertisement (P4-d).
 *
 * OFF BY DEFAULT (`mdns.enabled: false`): advertising a service on the LAN is a
 * new, discoverable surface, and this project's stance everywhere else is
 * "closed unless explicitly opened". When enabled, phones that speak mDNS can
 * find the console without typing an address.
 *
 * Honest limits (documented in README): iOS Safari and Android Chrome do NOT
 * resolve `.local` names for arbitrary web pages in practice, so mDNS helps
 * discovery tools and desktop browsers more than phone browsers. The QR code
 * remains the reliable path on a phone.
 *
 * The publisher is injectable so the lifecycle is testable without multicast.
 */
import { Bonjour } from 'bonjour-service'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'

/** Service type advertised as `_dsh-lan-guard._tcp`. */
export const MDNS_SERVICE_TYPE = 'dsh-lan-guard'
/** Default instance name. */
export const MDNS_INSTANCE_NAME = 'DSH 局域网访问'

/** One advertisement. */
export interface MdnsAdvertisement {
  /** Instance name shown by discovery tools. */
  name: string
  /** Service type (without the `_` and `._tcp` decorations). */
  type: string
  /** The proxy port. */
  port: number
  /** Discovery hints: the URL to open and whether it is TLS. */
  txt: Record<string, string>
}

/** The subset of the mDNS publisher this module uses. */
export interface MdnsPublisherLike {
  publish(record: MdnsAdvertisement): unknown
  unpublishAll(callback: () => void): void
  destroy(callback?: () => void): void
}

/** Build the advertisement for a running listener. */
export function mdnsAdvertisement(input: {
  port: number
  secure: boolean
  address: string | null
}): MdnsAdvertisement {
  const scheme = input.secure ? 'https' : 'http'
  const url = input.address === null ? null : `${scheme}://${input.address}:${String(input.port)}/`
  return {
    name: MDNS_INSTANCE_NAME,
    type: MDNS_SERVICE_TYPE,
    port: input.port,
    txt: {
      scheme,
      ...(url === null ? {} : { url }),
      ...(input.address === null ? {} : { host: input.address }),
    },
  }
}

/** A running advertisement. */
export interface MdnsHandle {
  /** Stop advertising. */
  stop(): void
}

/**
 * Start advertising, containing any failure.
 *
 * @param options - the advertisement plus an optional publisher (tests).
 * @returns a handle whose `stop()` tears the advertisement down.
 */
export function startMdns(options: {
  advertisement: MdnsAdvertisement
  publisher?: MdnsPublisherLike | undefined
  logger?: LanGuardLogger
}): MdnsHandle {
  const logger = options.logger ?? noopLogger
  let publisher: MdnsPublisherLike
  try {
    publisher = options.publisher ?? (new Bonjour() as unknown as MdnsPublisherLike)
  } catch (error) {
    logger.warn('mdns unavailable name=%s', (error as Error).name)
    return { stop() {} }
  }
  try {
    publisher.publish(options.advertisement)
    logger.info('mdns advertising type=_%s._tcp port=%d', options.advertisement.type, options.advertisement.port)
  } catch (error) {
    // Discovery is a convenience: never let it take the proxy down.
    logger.warn('mdns publish failed name=%s', (error as Error).name)
    return { stop() {} }
  }
  let stopped = false
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      try {
        publisher.unpublishAll(() => {
          try {
            publisher.destroy()
          } catch {
            // Already gone; nothing to release.
          }
        })
      } catch (error) {
        logger.warn('mdns unpublish failed name=%s', (error as Error).name)
      }
    },
  }
}
