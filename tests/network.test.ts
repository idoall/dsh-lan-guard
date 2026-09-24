/**
 * NIC discovery tests (docs/SPEC.md F5).
 *
 * The classification matters because the WRONG address is worse than none: a
 * Docker or VPN address looks plausible and simply never works on the phone.
 */
import { describe, expect, it } from 'vitest'
import { accessUrl, classifyInterface, listNetworkAddresses, selectAddress } from '../src/network.ts'

/** A synthetic candidate list. */
function candidates(): Parameters<typeof selectAddress>[0] {
  return [
    { interface: 'en0', address: '192.168.1.5', netmask: '255.255.255.0', virtual: false, rank: 0 },
    { interface: 'utun3', address: '100.64.0.2', netmask: '255.255.255.255', virtual: true, virtualReason: 'VPN or tunnel', rank: 1 },
  ]
}

describe('classifyInterface', () => {
  it('marks virtual bridges, tunnels and non-routable ranges', () => {
    expect(classifyInterface('docker0', '172.17.0.1').virtual).toBe(true)
    expect(classifyInterface('utun3', '10.1.1.1').virtual).toBe(true)
    expect(classifyInterface('tailscale0', '100.64.0.2').virtual).toBe(true)
    expect(classifyInterface('en0', '169.254.10.1').virtual).toBe(true)
  })

  it('treats ordinary Ethernet/Wi-Fi as real', () => {
    expect(classifyInterface('en0', '192.168.1.5')).toEqual({ virtual: false })
    expect(classifyInterface('wlan0', '10.0.0.9')).toEqual({ virtual: false })
  })
})

describe('listNetworkAddresses', () => {
  it('never reports loopback and is sorted with real adapters first', () => {
    const found = listNetworkAddresses()
    expect(Array.isArray(found)).toBe(true)
    for (const entry of found) expect(entry.address.startsWith('127.')).toBe(false)
    for (let index = 1; index < found.length; index += 1) {
      expect(found[index - 1]!.rank).toBeLessThanOrEqual(found[index]!.rank)
    }
  })
})

describe('selectAddress', () => {
  it('prefers a real adapter by default', () => {
    expect(selectAddress(candidates())?.interface).toBe('en0')
  })

  it('honours an explicit interface name or address', () => {
    expect(selectAddress(candidates(), 'utun3')?.interface).toBe('utun3')
    expect(selectAddress(candidates(), '100.64.0.2')?.interface).toBe('utun3')
  })

  it('returns nothing when the configured interface does not exist', () => {
    // Falling back would advertise an address the user explicitly did not pick.
    expect(selectAddress(candidates(), 'en9')).toBeUndefined()
  })

  it('returns nothing for an empty list', () => {
    expect(selectAddress([])).toBeUndefined()
  })
})

describe('accessUrl', () => {
  it('reflects the transport', () => {
    expect(accessUrl('192.168.1.5', 3445, true)).toBe('https://192.168.1.5:3445/')
    expect(accessUrl('192.168.1.5', 3445, false)).toBe('http://192.168.1.5:3445/')
  })
})
