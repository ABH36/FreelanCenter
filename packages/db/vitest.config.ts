import { defineConfig } from 'vitest/config';

// Unit tests only: no database. Integration tests run with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/static/**/*.test.ts'],
  },
});
