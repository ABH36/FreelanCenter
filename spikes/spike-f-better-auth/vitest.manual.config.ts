import { defineConfig } from 'vitest/config';

// Manual, human-in-the-loop runs only (`pnpm spike:oauth`). Never part of `pnpm spike:test`.
export default defineConfig({
  test: {
    include: ['scripts/**/*.manual.ts'],
    testTimeout: 6 * 60_000,
    fileParallelism: false,
  },
});
