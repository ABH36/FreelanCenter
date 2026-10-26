import { defineConfig } from 'vitest/config';

// Unit tests only: no database, no cache server. The integration suite runs with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
