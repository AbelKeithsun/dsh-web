import { defineConfig } from 'vitest/config'

/**
 * Host tests run in the Node environment (CDP, sockets, child processes);
 * browser-half tests need a DOM. `tests/client/**` gets jsdom, everything
 * else stays on Node so a host test never accidentally relies on DOM globals.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['tests/client/**', 'jsdom']],
  },
})
