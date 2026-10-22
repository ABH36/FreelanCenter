import { defineConfig } from 'vitest/config';

// Read-only checks against the deployed database configured in .env.local (never run in CI).
export default defineConfig({
  test: { include: ['test/live/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
