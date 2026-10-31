/**
 * Phase 1 audit-checkpoint E2E (SRS 12, P1 acceptance). Starts both apps in development mode (the dev mailbox
 * that captures the verification mail is a 404 in a production build) against the local Docker stack only:
 * `assertLocalStack` refuses any other database, so this suite can never touch a live project.
 *
 *   pnpm --filter @platform/db db:setup      # Postgres + PgBouncer + Redis (Upstash REST emulator) on 127.0.0.1
 *   pnpm --filter @platform/e2e test:e2e
 *
 * Nothing here is a secret: the auth secret below is a fixed value for synthetic local data, the Turnstile keys
 * are Cloudflare's published test keys and the Redis token is the emulator's fixed local token.
 */
import { defineConfig, devices } from '@playwright/test';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';

export const DASHBOARD = 'http://localhost:3000';
export const SITES_PORT = 3001;
/** `db:configure --target local` sets sites_domain to sites.localhost; Chromium resolves *.localhost itself. */
export const SITES_DOMAIN = 'sites.localhost';

const shared = {
  NEXT_TELEMETRY_DISABLED: '1',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:58079',
  UPSTASH_REDIS_REST_TOKEN: 'local-srh-token',
};

export default defineConfig({
  testDir: 'src',
  testMatch: '**/*.e2e.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'results',
  use: {
    baseURL: DASHBOARD,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @platform/dashboard exec next dev -p 3000',
      url: `${DASHBOARD}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...shared,
        DATABASE_URL: LOCAL_DATABASE_URLS.app,
        DATABASE_URL_AUTH: LOCAL_DATABASE_URLS.auth,
        DATABASE_URL_ADMIN: LOCAL_DATABASE_URLS.admin,
        BETTER_AUTH_URL: DASHBOARD,
        BETTER_AUTH_SECRET: 'e2e-local-only-synthetic-0123456789abcdef',
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        EMAIL_TRANSPORT: 'capture',
        JOBS_TRANSPORT: 'inline',
        // Free per-IP sign-in budgets between reruns on a non-fresh database come from unique users, not from here.
      },
    },
    {
      command: `pnpm --filter @platform/sites exec next dev -p ${SITES_PORT}`,
      url: `http://localhost:${SITES_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { ...shared, DATABASE_URL_PUBLIC: LOCAL_DATABASE_URLS.public },
    },
  ],
});
