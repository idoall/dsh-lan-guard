/**
 * dsh-lan-guard — the self-signed certificate authority.
 *
 * The CA is the long-lived identity a phone trusts once. Parameters follow the
 * researched dsh-mobile set: EC P-256, SHA-256,
 * `basicConstraints: cA: true`, `keyUsage` with `keyCertSign`.
 *
 * The subject common name is a user decision (2026-09-24): "DSH LAN Guard CA".
 *
 * The CA private key never leaves the plugin's private dataDir, is written with
 * mode 600, and is never logged.
 */
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { generate } from 'selfsigned'

/** The CA subject common name (user decision, 2026-09-24). */
export const CA_COMMON_NAME = 'DSH LAN Guard CA'
/** CA validity in days (5 years). */
export const CA_VALIDITY_DAYS = 365 * 5

/** One CA key pair. */
export interface CaMaterial {
  /** PEM certificate. */
  cert: string
  /** PEM private key. */
  key: string
  /** SHA-256 fingerprint of the certificate (safe to display). */
  fingerprint: string
}

/** Write a file that must not be world-readable. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
}

/** Write a public certificate (safe to be readable). */
export async function writePublicFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o644 })
}

/** The SHA-256 fingerprint of a PEM certificate. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
}

/**
 * Assert that a certificate and a private key belong together.
 *
 * Without this check a rotated or half-copied pair fails much later, as an
 * opaque TLS handshake error on the phone.
 *
 * @param certPem - PEM certificate.
 * @param keyPem - PEM private key.
 * @throws when the pair does not match or the certificate is not a CA.
 */
export function assertMatchingCa(certPem: string, keyPem: string): void {
  const certificate = new X509Certificate(certPem)
  if (!certificate.ca) throw new Error('dsh-lan-guard: CA certificate is not a CA (basicConstraints cA)')
  if (certificate.subject !== certificate.issuer) {
    throw new Error('dsh-lan-guard: CA certificate is not self-signed')
  }
  if (!certificate.verify(certificate.publicKey)) {
    throw new Error('dsh-lan-guard: CA certificate signature does not verify against its own key')
  }
  const keyPublic = createPublicKey(createPrivateKey(keyPem))
  const certPublic = certificate.publicKey
  const keyDer = keyPublic.export({ type: 'spki', format: 'der' })
  const certDer = certPublic.export({ type: 'spki', format: 'der' })
  if (!Buffer.from(keyDer).equals(Buffer.from(certDer))) {
    throw new Error('dsh-lan-guard: CA private key does not match the CA certificate')
  }
}

/** Generate a fresh self-signed CA. */
export async function generateCa(): Promise<CaMaterial> {
  const notBeforeDate = new Date(Date.now() - 5 * 60 * 1_000)
  const notAfterDate = new Date(Date.now() + CA_VALIDITY_DAYS * 24 * 60 * 60 * 1_000)
  const pems = await generate([{ name: 'commonName', value: CA_COMMON_NAME }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyCertSign: true,
        cRLSign: true,
        critical: true,
      },
    ],
  })
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert) }
}

/** Load a CA from disk and prove the pair matches. */
export async function loadCa(certPath: string, keyPath: string): Promise<CaMaterial> {
  const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')])
  assertMatchingCa(cert, key)
  return { cert, key, fingerprint: fingerprintOf(cert) }
}

/**
 * Load the CA from disk, generating it once when missing.
 *
 * The CA identity is retained across restarts on purpose: replacing it would
 * force every phone to re-trust a new CA.
 *
 * @param certPath - where the CA certificate lives.
 * @param keyPath - where the CA private key lives.
 * @returns the CA material.
 */
export async function ensureCa(certPath: string, keyPath: string): Promise<CaMaterial> {
  try {
    return await loadCa(certPath, keyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const generated = await generateCa()
  await writePrivateFile(keyPath, generated.key)
  await writePublicFile(certPath, generated.cert)
  return generated
}
