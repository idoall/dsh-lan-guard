/**
 * Minimal HTTP client for the proxy suite: it must be able to send a raw
 * request target (absolute-form included) and return the exact response bytes,
 * which the higher-level helpers cannot express.
 */
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'

/** One complete response. */
export interface RawResponse {
  status: number
  statusMessage: string
  headers: IncomingHttpHeaders
  body: Buffer
}

/** Options for {@link requestTo}. */
export interface RawRequestOptions {
  method?: string
  /** Raw request target, e.g. `/` or `http://127.0.0.1:3445` (absolute-form). */
  path?: string
  headers?: OutgoingHttpHeaders
  body?: Buffer | string
}

/**
 * Send one request to a loopback port and collect the full response.
 *
 * @param port - target port on `127.0.0.1`.
 * @param options - method, raw target, headers and body.
 * @returns the status, headers and body.
 */
export function requestTo(port: number, options: RawRequestOptions = {}): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** Find a free loopback port by binding port 0 and reading it back. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:http')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
