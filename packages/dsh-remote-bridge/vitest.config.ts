import { defineConfig } from 'vitest/config'

/**
 * This package's suites drive the protocol state machine over a recording
 * carrier and real node crypto, so node is the only environment they need and
 * no path aliasing is involved. The include list keeps the scan on the two
 * source roots and off the emitted lib/ tree.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
