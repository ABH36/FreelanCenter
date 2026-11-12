/**
 * Starts both apps in development mode against the local Docker stack, for the Owner's acceptance test (the same
 * environment as the Playwright journey, with synthetic secrets and Cloudflare's published Turnstile test keys):
 *
 *   pnpm --filter @platform/db db:setup && pnpm --filter @platform/db db:seed-templates
 *   pnpm --filter @platform/e2e acceptance          # development servers (dev mail box for sign-up)
 *   pnpm --filter @platform/e2e acceptance --prod   # production builds: no hot reload (use this for browser
 *                                                   # agents and manual review; dev hot reload can reload a page
 *                                                   # in a loop in some browser set-ups). No dev mail box here,
 *                                                   # so create the test account with the development mode first.
 *
 * Dashboard http://localhost:3000, sites http://localhost:3001, preview host http://preview.sites.localhost:3001,
 * sign-up mail box http://localhost:3000/dev/mailbox. Ctrl+C stops both. Nothing here touches a live project.
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { LOCAL_DATABASE_URLS } from '../../../packages/db/src/env.ts';

const shared = {
  NEXT_TELEMETRY_DISABLED: '1',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:58079',
  UPSTASH_REDIS_REST_TOKEN: 'local-srh-token',
  PREVIEW_HOST: 'preview.sites.localhost',
  PREVIEW_TOKEN_SECRET: 'e2e-preview-secret-local-only-synthetic-0123456789',
};
const apps = [
  {
    name: 'dashboard',
    port: 3000,
    env: {
      DATABASE_URL: LOCAL_DATABASE_URLS.app,
      DATABASE_URL_AUTH: LOCAL_DATABASE_URLS.auth,
      DATABASE_URL_ADMIN: LOCAL_DATABASE_URLS.admin,
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'e2e-local-only-synthetic-0123456789abcdef',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      EMAIL_TRANSPORT: 'capture',
      JOBS_TRANSPORT: 'inline',
    },
  },
  { name: 'sites', port: 3001, env: { DATABASE_URL_PUBLIC: LOCAL_DATABASE_URLS.public } },
];

const prod = process.argv.includes('--prod');
if (prod) {
  for (const app of apps) {
    const built = spawnSync('pnpm', ['--filter', `@platform/${app.name}`, 'build'], {
      env: { ...process.env, ...shared, ...app.env },
      stdio: 'inherit',
      shell: true,
    });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
}

const children = apps.map((app) =>
  spawn(
    'pnpm',
    ['--filter', `@platform/${app.name}`, 'exec', 'next', prod ? 'start' : 'dev', '-p', String(app.port)],
    {
      env: { ...process.env, ...shared, ...app.env },
      stdio: 'inherit',
      shell: true,
    },
  ),
);
const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
