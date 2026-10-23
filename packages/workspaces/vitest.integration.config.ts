import { defineConfig } from 'vitest/config';

// Workspace service suite against the local Docker stack (`pnpm --filter @platform/db db:setup` first).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
