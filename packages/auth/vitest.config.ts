import { defineConfig } from 'vitest/config';

// Unit tests only: no database. The product auth suite runs with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Some unit tests import better-auth dynamically; the first import took 6-10 s on a loaded 2-core machine and hit
    // the 5 s default (flaky in the P2 S2 and S3 clean-worktree runs). The timeout is a bound, not a retry.
    testTimeout: 30_000,
  },
});
