import { defineConfig } from 'vitest/config'

// Specs import src/ directly (never the built lib/ artifacts), so the suite
// runs with no build step. Everything in P1 is host-side logic: plain node.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
