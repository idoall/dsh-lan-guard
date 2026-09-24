/**
 * mDNS advertisement tests (P4-d).
 *
 * Multicast is not available in a test sandbox, so the lifecycle is exercised
 * through an injected publisher; the advertisement itself is a pure function.
 * The load-bearing promise is containment: discovery must never take the proxy
 * down, and `stop()` must release the advertisement.
 */
import { describe, expect, it } from 'vitest'
import { MDNS_INSTANCE_NAME, MDNS_SERVICE_TYPE, mdnsAdvertisement, startMdns } from '../src/mdns.ts'
import type { MdnsPublisherLike } from '../src/mdns.ts'

/** A publisher that records what it was asked to do. */
function fakePublisher(): { publisher: MdnsPublisherLike; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    publisher: {
      publish(record) {
        calls.push(`publish:${record.type}:${String(record.port)}`)
      },
      unpublishAll(callback) {
        calls.push('unpublishAll')
        callback()
      },
      destroy() {
        calls.push('destroy')
      },
    },
  }
}

describe('mdnsAdvertisement', () => {
  it('describes the running listener', () => {
    const record = mdnsAdvertisement({ port: 3081, secure: true, address: '10.0.0.20' })
    expect(record.type).toBe(MDNS_SERVICE_TYPE)
    expect(record.name).toBe(MDNS_INSTANCE_NAME)
    expect(record.port).toBe(3081)
    expect(record.txt.url).toBe('https://10.0.0.20:3081/')
    expect(record.txt.scheme).toBe('https')
  })

  it('omits the url when no address is known, and reflects plain HTTP', () => {
    const record = mdnsAdvertisement({ port: 3081, secure: false, address: null })
    expect(record.txt.url).toBeUndefined()
    expect(record.txt.scheme).toBe('http')
  })
})

describe('startMdns', () => {
  it('publishes once and releases on stop', () => {
    const { publisher, calls } = fakePublisher()
    const handle = startMdns({
      advertisement: mdnsAdvertisement({ port: 3081, secure: true, address: '10.0.0.20' }),
      publisher,
    })
    expect(calls).toEqual([`publish:${MDNS_SERVICE_TYPE}:3081`])
    handle.stop()
    expect(calls).toEqual([`publish:${MDNS_SERVICE_TYPE}:3081`, 'unpublishAll', 'destroy'])
    handle.stop()
    expect(calls).toHaveLength(3)
  })

  it('contains a publish failure instead of throwing', () => {
    const publisher: MdnsPublisherLike = {
      publish() {
        throw new Error('no multicast here')
      },
      unpublishAll(callback) {
        callback()
      },
      destroy() {},
    }
    const handle = startMdns({
      advertisement: mdnsAdvertisement({ port: 1, secure: false, address: null }),
      publisher,
    })
    expect(() => handle.stop()).not.toThrow()
  })
})
