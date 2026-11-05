import { defineConfig } from 'vitest/config';

// Unit tests only: no database. Integration tests run with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/static/**/*.test.ts'],
    // The static source scans read the whole repository; on a loaded 2-core machine one took 6.9 s and hit the 5 s
    // default (P2 S4 clean-worktree run). A bound, not a retry; the assertions are unchanged.
    testTimeout: 30_000,
  },
});
