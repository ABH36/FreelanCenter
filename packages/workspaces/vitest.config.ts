import { defineConfig } from 'vitest/config';

// Unit tests only: no database. The service suite runs with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
