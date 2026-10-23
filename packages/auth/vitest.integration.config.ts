import { defineConfig } from 'vitest/config';

// Product auth suite against the local Docker stack (`pnpm --filter @platform/db db:setup` first). It reaches
// Cloudflare's Turnstile siteverify with the official test keys, so it needs outbound HTTPS.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
