/**
 * dsh-lan-guard — network interface discovery (docs/SPEC.md F5).
 *
 * The LAN address a phone must type depends on which NIC is actually on the
 * same network. Virtual adapters (WSL, VMware, Docker, Tailscale, VPN tunnels)
 * usually have an address that looks fine but is unreachable from the phone, so
 * they are reported but DOWN-RANKED rather than hidden: hiding them would make
 * a legitimate VPN-only setup impossible, and ranking them first would make the
 * common case wrong.
 */
import { networkInterfaces } from 'node:os'

/** One usable IPv4 address. */
export interface NetworkAddress {
  /** Interface name, e.g. `en0`. */
  interface: string
  /** The IPv4 literal. */
  address: string
  /** Netmask. */
  netmask: string
  /** Whether this looks like a virtual / tunnel adapter. */
  virtual: boolean
  /** Why it was classified as virtual. */
  virtualReason?: string
  /** Sort key: lower is more likely to be the address a phone can reach. */
  rank: number
}

/** Interface-name prefixes that almost never serve a phone on the same Wi-Fi. */
const VIRTUAL_INTERFACE_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^(bridge|docker|veth|virbr|vmnet|vboxnet)/i, reason: 'container/virtual bridge' },
  { pattern: /^(utun|tun|tap|wg|ppp|ipsec|tailscale)/i, reason: 'VPN or tunnel' },
  { pattern: /^(awdl|llw|ap\d)/i, reason: 'Apple peer-to-peer / hotspot' },
]

/** Address ranges that are never a phone-reachable LAN address. */
const NON_ROUTABLE_PREFIXES = ['169.254.', '172.17.', '172.18.', '172.19.']

/** Whether an address is IPv4 and not loopback / link-local. */
function isUsable(address: string, family: string | number): boolean {
  if (family !== 'IPv4' && family !== 4) return false
  if (address.startsWith('127.')) return false
  return true
}

/** Classify one interface/address pair as virtual (down-ranked) or real. */
export function classifyInterface(name: string, address: string): { virtual: boolean; reason?: string } {
  for (const entry of VIRTUAL_INTERFACE_PATTERNS) {
    if (entry.pattern.test(name)) return { virtual: true, reason: entry.reason }
  }
  for (const prefix of NON_ROUTABLE_PREFIXES) {
    if (address.startsWith(prefix)) return { virtual: true, reason: 'non-routable private range' }
  }
  return { virtual: false }
}

/**
 * Enumerate the machine's non-internal IPv4 addresses, best candidate first.
 *
 * @returns addresses sorted by rank (real Wi-Fi/Ethernet first, virtual last).
 */
export function listNetworkAddresses(): NetworkAddress[] {
  const found: NetworkAddress[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!isUsable(entry.address, entry.family)) continue
      const { virtual, reason } = classifyInterface(name, entry.address)
      found.push({
        interface: name,
        address: entry.address,
        netmask: entry.netmask,
        virtual,
        ...(reason === undefined ? {} : { virtualReason: reason }),
        rank: virtual ? 1 : 0,
      })
    }
  }
  return found.sort((left, right) => (
    left.rank - right.rank
    || left.interface.localeCompare(right.interface)
    || left.address.localeCompare(right.address)
  ))
}

/**
 * Pick the address a phone should use.
 *
 * @param addresses - the enumerated list.
 * @param preferredInterface - an explicit `networkInterface` from config, if any.
 * @returns the chosen address, or `undefined` when nothing is usable.
 */
export function selectAddress(
  addresses: readonly NetworkAddress[],
  preferredInterface?: string | null,
): NetworkAddress | undefined {
  if (preferredInterface !== undefined && preferredInterface !== null && preferredInterface !== '') {
    const match = addresses.find(entry => entry.interface === preferredInterface)
    if (match !== undefined) return match
    const byAddress = addresses.find(entry => entry.address === preferredInterface)
    if (byAddress !== undefined) return byAddress
    // An explicitly configured interface that does not exist must not silently
    // fall back to another NIC: that would publish a URL the user did not pick.
    return undefined
  }
  return addresses[0]
}

/**
 * Build the visitor URL for one address.
 *
 * @param address - the chosen address.
 * @param port - the proxy port.
 * @param secure - whether the listener serves TLS.
 * @returns the URL a phone can open.
 */
export function accessUrl(address: string, port: number, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${address}:${String(port)}/`
}
