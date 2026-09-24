/**
 * Certificate tests (docs/SPEC.md F4).
 *
 * The load-bearing property is CA IDENTITY STABILITY: the CA must survive
 * restarts and address changes, while the leaf is re-signed. Otherwise every
 * renewal would force the phone to trust a new CA again.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CA_COMMON_NAME, assertMatchingCa, ensureCa, fingerprintOf, generateCa } from '../src/tls/ca.ts'
import { ensureLeaf } from '../src/tls/leaf.ts'
import { tmpDataDir } from './helpers/tmp.ts'

describe('CA', () => {
  it('generates a self-signed CA with the agreed subject', async () => {
    const ca = await generateCa()
    const certificate = new X509Certificate(ca.cert)
    expect(certificate.ca).toBe(true)
    expect(certificate.subject).toContain(CA_COMMON_NAME)
    expect(certificate.subject).toBe(certificate.issuer)
    expect(certificate.fingerprint256).toBe(ca.fingerprint)
    expect(() => assertMatchingCa(ca.cert, ca.key)).not.toThrow()
  })

  it('rejects a mismatched key pair', async () => {
    const first = await generateCa()
    const second = await generateCa()
    expect(() => assertMatchingCa(first.cert, second.key)).toThrow(/does not match/)
  })

  it('rejects a non-CA certificate', async () => {
    const directory = await tmpDataDir()
    const ca = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
    const leaf = await ensureLeaf({
      ca,
      addresses: ['192.168.1.5'],
      certPath: join(directory, 'leaf.pem'),
      keyPath: join(directory, 'leaf-key.pem'),
    })
    expect(() => assertMatchingCa(leaf.cert, leaf.key)).toThrow(/not a CA/)
  })

  it('retains the CA identity across restarts', async () => {
    const directory = await tmpDataDir()
    const certPath = join(directory, 'ca.pem')
    const keyPath = join(directory, 'ca-key.pem')
    const first = await ensureCa(certPath, keyPath)
    const second = await ensureCa(certPath, keyPath)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.cert).toBe(first.cert)
  })

  it('writes the CA key with mode 600 and the certificate readable', async () => {
    const directory = await tmpDataDir()
    const certPath = join(directory, 'ca.pem')
    const keyPath = join(directory, 'ca-key.pem')
    await ensureCa(certPath, keyPath)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
    expect((await stat(certPath)).mode & 0o777).toBe(0o644)
  })
})

describe('leaf', () => {
  it('covers every requested address plus loopback', async () => {
    const directory = await tmpDataDir()
    const ca = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
    const leaf = await ensureLeaf({
      ca,
      addresses: ['192.168.1.5'],
      certPath: join(directory, 'leaf.pem'),
      keyPath: join(directory, 'leaf-key.pem'),
    })
    const certificate = new X509Certificate(leaf.cert)
    // Node's checkIP returns the matched address (truthy) or undefined.
    expect(certificate.checkIP('192.168.1.5')).toBeTruthy()
    expect(certificate.checkIP('127.0.0.1')).toBeTruthy()
    expect(certificate.checkIP('10.0.0.9')).toBeFalsy()
    expect(certificate.verify(new X509Certificate(ca.cert).publicKey)).toBe(true)
  })

  it('reuses an existing leaf while it still covers the addresses', async () => {
    const directory = await tmpDataDir()
    const ca = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
    const options = {
      ca,
      addresses: ['192.168.1.5'],
      certPath: join(directory, 'leaf.pem'),
      keyPath: join(directory, 'leaf-key.pem'),
    }
    const first = await ensureLeaf(options)
    const second = await ensureLeaf(options)
    expect(second.cert).toBe(first.cert)
  })

  it('re-signs the leaf for a new address WITHOUT changing the CA', async () => {
    const directory = await tmpDataDir()
    const ca = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
    const certPath = join(directory, 'leaf.pem')
    const keyPath = join(directory, 'leaf-key.pem')
    await ensureLeaf({ ca, addresses: ['192.168.1.5'], certPath, keyPath })

    const renewed = await ensureLeaf({ ca, addresses: ['192.168.1.77'], certPath, keyPath })
    expect(new X509Certificate(renewed.cert).checkIP('192.168.1.77')).toBeTruthy()
    const reloaded = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
    expect(reloaded.fingerprint).toBe(ca.fingerprint)
    expect(fingerprintOf(reloaded.cert)).toBe(ca.fingerprint)
  })

  it('renews a leaf that is about to expire', async () => {
    const directory = await tmpDataDir()
    const ca = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
    const certPath = join(directory, 'leaf.pem')
    const keyPath = join(directory, 'leaf-key.pem')
    await ensureLeaf({ ca, addresses: ['192.168.1.5'], certPath, keyPath })
    // One year later the 1-year leaf is inside the renewal window.
    const later = Date.now() + 360 * 24 * 60 * 60 * 1_000
    const renewed = await ensureLeaf({
      ca,
      addresses: ['192.168.1.5'],
      certPath,
      keyPath,
      now: () => later,
    })
    expect(new Date(renewed.cert.length > 0 ? new X509Certificate(renewed.cert).validTo : 0).getTime()).toBeGreaterThan(later)
  })
})
