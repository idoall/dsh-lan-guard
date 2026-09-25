/**
 * dsh-lan-guard — the per-address leaf certificate.
 *
 * The leaf is short-lived and is RE-SIGNED whenever the machine's addresses
 * change (DHCP, Wi-Fi switch, a new NIC). The CA identity never changes, so a
 * phone that trusted the CA once keeps working.
 *
 * The leaf carries every current address as a SAN, so the same certificate
 * serves whichever URL the phone was given.
 */
import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { generate } from 'selfsigned'
import { fingerprintOf, writePrivateFile, writePublicFile, type CaMaterial } from './ca.ts'

/** Leaf validity in days; short on purpose because renewal is cheap. */
export const LEAF_VALIDITY_DAYS = 365
/** Renew this long before expiry so a phone never meets an expired certificate. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1_000

/** One leaf key pair. */
export interface LeafMaterial {
  /** PEM certificate. */
  cert: string
  /** PEM private key. */
  key: string
  /** SHA-256 fingerprint. */
  fingerprint: string
  /** Addresses covered by the SAN list. */
  addresses: string[]
}

/** Options for {@link ensureLeaf}. */
export interface LeafOptions {
  /** The signing CA. */
  ca: CaMaterial
  /** Every address the leaf must cover (plus loopback). */
  addresses: readonly string[]
  /** Where the leaf certificate lives. */
  certPath: string
  /** Where the leaf private key lives. */
  keyPath: string
  /** Clock injection for tests. */
  now?: () => number
}

/** Whether an existing leaf still satisfies the request. */
function leafIsReusable(
  certPem: string,
  ca: CaMaterial,
  addresses: readonly string[],
  now: number,
): boolean {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(certPem)
  } catch {
    return false
  }
  try {
    if (!certificate.verify(new X509Certificate(ca.cert).publicKey)) return false
  } catch {
    return false
  }
  if (new Date(certificate.validTo).getTime() - RENEW_BEFORE_MS <= now) return false
  for (const address of addresses) {
    try {
      if (!certificate.checkIP(address)) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Ensure a leaf certificate signed by the CA covers the given addresses.
 *
 * @param options - the CA, the addresses and the on-disk locations.
 * @returns the leaf material in use.
 */
export async function ensureLeaf(options: LeafOptions): Promise<LeafMaterial> {
  const now = (options.now ?? (() => Date.now()))()
  const wanted = [...new Set([...options.addresses, '127.0.0.1', '::1'])]

  try {
    const existing = await readFile(options.certPath, 'utf8')
    if (leafIsReusable(existing, options.ca, wanted, now)) {
      const key = await readFile(options.keyPath, 'utf8')
      return {
        cert: existing,
        key,
        fingerprint: fingerprintOf(existing),
        addresses: wanted,
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const notBeforeDate = new Date(now - 5 * 60 * 1_000)
  const notAfterDate = new Date(now + LEAF_VALIDITY_DAYS * 24 * 60 * 60 * 1_000)
  const pems = await generate([{ name: 'commonName', value: 'dsh-lan-guard' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    ca: { key: options.ca.key, cert: options.ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: wanted.map(address => ({ type: 7 as const, ip: address })),
      },
    ],
  })
  await writePrivateFile(options.keyPath, pems.private)
  await writePublicFile(options.certPath, pems.cert)
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert), addresses: wanted }
}
