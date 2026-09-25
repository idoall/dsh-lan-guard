/**
 * Test scratch space.
 *
 * Everything is created under `<repo>/.tmp/` (gitignored) on purpose: the
 * suite must not write anywhere outside this repository, and the plugin's secrets store needs a real
 * directory to exercise mode 600.
 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../.tmp/test-data', import.meta.url))

/** Create a fresh private data directory for one test. */
export async function tmpDataDir(): Promise<string> {
  await mkdir(ROOT, { recursive: true })
  return await mkdtemp(join(ROOT, 'run-'))
}
