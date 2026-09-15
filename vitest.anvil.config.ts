import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // These tests spawn scenario seeding and wait on real Anvil transactions, so vitest's 5s default
    // fails them on a loaded machine. 90s matches the Playwright suite's per-test budget.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    include: ['tests/e2e/anvil/**/*.test.mts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
