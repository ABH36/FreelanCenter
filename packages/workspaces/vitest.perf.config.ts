import { defineConfig } from 'vitest/config';

// NFR-PERF-04 measurement against the local Docker stack (`pnpm --filter @platform/db db:setup` first).
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
