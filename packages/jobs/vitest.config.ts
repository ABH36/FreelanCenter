import { defineConfig } from 'vitest/config';

// Unit tests only. The signed-executor suite (Docker) runs with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
