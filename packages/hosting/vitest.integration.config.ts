import { defineConfig } from 'vitest/config';

// Against the local Docker stack: Postgres + PgBouncer and the Upstash REST emulator
// (`pnpm --filter @platform/db db:setup` first).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
