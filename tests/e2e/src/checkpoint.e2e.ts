/**
 * Phase 1 audit checkpoint (SRS 12): a user signs up, verifies the e-mail, creates a workspace and a project and
 * reaches its unique subdomain; a second user's workspace cannot see, list or modify the first's data through the
 * UI, the API (forged workspace id in a server action, audit export) or direct database access as `app_user`.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SITES_DOMAIN, SITES_PORT } from '../playwright.config';
import { appPool, asTenant, authPool, userIdByEmail } from './local-stack';

const PASSWORD = 'E2e-Local-Pass-0123456789';
const run = randomUUID().slice(0, 8);

interface Actor {
  email: string;
  slug: string;
  workspaceId: string;
  userId: string;
  context: BrowserContext;
  page: Page;
}

/** Sign-up -> verification link from the dev mailbox -> (auto sign-in) -> first workspace. */
async function onboard(browser: Browser, label: string): Promise<Actor> {
  const email = `e2e-${label}-${run}@example.test`;
  const slug = `e2e-${label}-${run}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/sign-up');
  await page.getByLabel('Full name').fill(`E2E ${label} ${run}`);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  // Cloudflare's always-pass test key hands out a token on its own; the submit button enables with it.
  const submit = page.getByRole('button', { name: 'Create account' });
  await expect(submit).toBeEnabled({ timeout: 60_000 });
  await submit.click();
  await expect(page.getByText(email)).toBeVisible();

  // The capture inbox is per dev server; the link is the only way to verify (FR-AUTH-01).
  await page.goto('/dev/mailbox');
  const row = page
    .getByTestId('mail')
    .filter({ has: page.getByTestId('mail-to').filter({ hasText: email }) });
  const link = await row.first().getByTestId('mail-link').getAttribute('href');
  expect(link).toContain('/api/auth/verify-email');
  await page.goto(link as string);

  // Verified accounts are signed in on return; the first screen is the workspace creator.
  await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
  await page.getByLabel('Workspace name').fill(`Agency ${label} ${run}`);
  await page.getByLabel('Address').fill(slug);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL(`**/w/${slug}**`);

  const auth = authPool();
  const userId = await userIdByEmail(auth, email);
  await auth.end();
  await page.goto(`/w/${slug}/projects/new`);
  const workspaceId = await page.locator('input[name="workspaceId"]').first().inputValue();
  return { email, slug, workspaceId, userId, context, page };
}

test.describe.configure({ mode: 'serial' });

let a: Actor;
let b: Actor;
let projectName: string;
let projectId: string;
let hostname: string;

test.beforeAll(async ({ browser, request }) => {
  // Development servers compile a route on its first request and reload open pages while doing so. Warm the
  // routes the journey needs, so the sign-up form is not reloaded under the browser while it waits for its token.
  test.setTimeout(300_000);
  for (const path of ['/sign-up', '/sign-in', '/dev/mailbox', '/api/auth/ok']) await request.get(path);
  await request.get(`http://127.0.0.1:${SITES_PORT}/api/health`);
  a = await onboard(browser, 'a');
  b = await onboard(browser, 'b');
});

test.afterAll(async () => {
  await a?.context.close();
  await b?.context.close();
});

test('user A creates a project that gets a unique platform address', async () => {
  projectName = `Gym ${run}`;
  await a.page.goto(`/w/${a.slug}/projects/new`);
  await a.page.getByLabel('Business name').fill(projectName);
  await a.page.getByRole('button', { name: 'Create project' }).click();
  await a.page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  projectId = /\/projects\/([0-9a-f-]{36})$/.exec(a.page.url())?.[1] as string;
  hostname = (await a.page.getByTestId('project-address').innerText()).trim();
  expect(hostname.endsWith(`.${SITES_DOMAIN}`)).toBe(true);
});

test('the subdomain serves the placeholder; an unknown host does not', async ({ page }) => {
  // Plain DNS for *.localhost is not guaranteed in every runner; the Host header is what the app routes on.
  const visit = (host: string) =>
    page.request.get(`http://127.0.0.1:${SITES_PORT}/`, {
      headers: { host: `${host}:${SITES_PORT}` },
      maxRedirects: 0,
    });
  const known = await visit(hostname);
  expect(known.status()).toBe(200);
  expect(known.headers()['x-content-type-options']).toBe('nosniff');
  const unknown = await visit(`nobody-${run}.${SITES_DOMAIN}`);
  expect(unknown.status()).toBe(404);
  // The visitor page never names the workspace, the project or the tenant (data minimisation).
  const body = await known.text();
  expect(body).not.toContain(projectName);
  expect(body).not.toContain(a.slug);
});

test("UI: user B cannot open, list or search A's data", async () => {
  for (const path of [
    `/w/${a.slug}`,
    `/w/${a.slug}/projects`,
    `/w/${a.slug}/projects/${projectId}`,
    `/w/${a.slug}/members`,
    `/w/${a.slug}/audit`,
    `/w/${a.slug}/settings`,
  ]) {
    const response = await b.page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
  // B's own list holds nothing of A's, whatever B searches for.
  await b.page.goto(`/w/${b.slug}/projects?q=${encodeURIComponent(projectName)}`);
  await expect(b.page.getByText(projectName)).toHaveCount(0);
  // The same project id under B's own workspace is a missing id, not a forbidden one.
  const own = await b.page.goto(`/w/${b.slug}/projects/${projectId}`);
  expect(own?.status()).toBe(404);
  // No B page names A.
  await b.page.goto('/');
  await expect(b.page.getByText(a.slug)).toHaveCount(0);
});

test("API: B's requests with A's ids are refused and change nothing", async () => {
  const exported = await b.context.request.get(`/w/${a.slug}/audit/export`);
  expect(exported.status()).toBe(404);

  // A forged server action: B's own form, with the hidden workspace id swapped for A's (never trusted, SEC-01).
  await b.page.goto(`/w/${b.slug}/projects/new`);
  await b.page
    .locator('input[name="workspaceId"]')
    .first()
    .evaluate((el, id) => {
      (el as unknown as { value: string }).value = id;
    }, a.workspaceId);
  await b.page.getByLabel('Business name').fill(`Forged ${run}`);
  await b.page.getByRole('button', { name: 'Create project' }).click();
  await expect(b.page.getByRole('alert').first()).toBeVisible();
  expect(b.page.url()).not.toMatch(/\/projects\/[0-9a-f-]{36}$/);

  // A's data is unchanged: the project under its own name, and nothing the forgery tried to add.
  await a.page.goto(`/w/${a.slug}/projects`);
  await expect(a.page.getByText(projectName)).toBeVisible();
  await expect(a.page.getByText(`Forged ${run}`)).toHaveCount(0);
});

test("SQL: as app_user, B's context sees, changes and deletes nothing of A's", async () => {
  const app = appPool();
  try {
    // Honest context: B's workspace, B's id. A's project is invisible and immutable.
    await asTenant(app, b.workspaceId, b.userId, async (c) => {
      const seen = await c.query('SELECT count(*)::int AS n FROM app.projects WHERE id = $1', [projectId]);
      expect(seen.rows[0].n).toBe(0);
      const all = await c.query('SELECT workspace_id FROM app.projects');
      expect(all.rows.every((r: { workspace_id: string }) => r.workspace_id === b.workspaceId)).toBe(true);
      const upd = await c.query(`UPDATE app.projects SET name = 'pwned' WHERE id = $1`, [projectId]);
      expect(upd.rowCount).toBe(0);
      const ws = await c.query('SELECT count(*)::int AS n FROM app.workspaces WHERE id = $1', [
        a.workspaceId,
      ]);
      expect(ws.rows[0].n).toBe(0);
    });
    // app_user holds no DELETE on projects at all (soft delete only): refused by privilege, before any row is read.
    await expect(
      asTenant(app, a.workspaceId, a.userId, (c) =>
        c.query('DELETE FROM app.projects WHERE id = $1', [projectId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // The database boundary is the workspace id; membership is proven server-side before a TenantScope exists
    // (packages/db/src/client.ts), which the forged server action above exercises.
    // Control: A's own context does see the project, so the zeros above are isolation, not an empty table.
    await asTenant(app, a.workspaceId, a.userId, async (c) => {
      const seen = await c.query('SELECT name FROM app.projects WHERE id = $1', [projectId]);
      expect(seen.rows[0]?.name).toBe(projectName);
    });
  } finally {
    await app.end();
  }
});

test("A's audit log shows the events of the journey", async () => {
  await a.page.goto(`/w/${a.slug}/audit`);
  await expect(a.page.getByText(/project\.created/).first()).toBeVisible();
});
