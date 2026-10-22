import { defineConfig } from 'vitest/config';

// Needs the Docker stack (`pnpm --filter @platform/db db:setup`). Not part of `pnpm test`: it runs in the
// `db-integration` CI job. The verbose reporter prints one line per table and check (the per-table evidence);
// the JSON report is uploaded as a CI artefact.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    reporters: ['verbose', ['json', { outputFile: 'results/isolation-report.json' }]],
  },
});
