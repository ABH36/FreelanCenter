import { defineConfig } from 'vitest/config';

// Signed end-to-end run against a local `inngest start` executor in Docker (test/global-setup.ts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
