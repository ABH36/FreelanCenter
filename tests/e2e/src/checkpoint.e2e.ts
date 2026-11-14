/**
 * Phase 1 audit checkpoint (SRS 12): a user signs up, verifies the e-mail, creates a workspace and a project and
 * reaches its unique subdomain; a second user's workspace cannot see, list or modify the first's data through the
 * UI, the API (forged workspace id in a server action, audit export) or direct database access as `app_user`.
 */
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
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
  await page.getByLabel('Web address').fill(slug);
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
    `/w/${a.slug}/projects/${projectId}/editor`,
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

// P2 S6b (FR-TPL-09): a freelancer makes a preview link in the dashboard and a prospect, with no account and no
// cookies, opens it on the preview host and clicks through the template.
test('A shares a template preview; a prospect opens it without signing in and stays inside the link', async ({
  browser,
}) => {
  await a.page.goto(`/w/${a.slug}/templates`);
  const card = a.page.locator('li', { has: a.page.getByRole('heading', { name: 'Gym Bold' }) });
  await card.getByLabel('Business name').fill('Sharma Fitness');
  await card.getByRole('button', { name: 'Create preview link' }).click();
  const link = await card.getByLabel('Preview link').inputValue();
  expect(link).toMatch(/^http:\/\/preview\.sites\.localhost:3001\/p\/v1\.[\w-]+\.[\w-]+$/);

  // The prospect: a brand-new browser context (no cookies, no session of A).
  const prospect = await browser.newContext();
  try {
    const page = await prospect.newPage();
    // Runs in the browser: collects Content-Security-Policy violations (a string, because this package has no DOM types).
    await page.addInitScript(
      "document.addEventListener('securitypolicyviolation', (e) => { (globalThis.__v ??= []).push(e.violatedDirective); });",
    );
    const res = await page.goto(link);
    expect(res?.status()).toBe(200);
    expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.locator('.pb-banner')).toContainText('Website preview for "Sharma Fitness"');
    await expect(page.locator('.pb-brand').first()).toHaveText('Sharma Fitness');
    // Every in-site link stays inside the preview: the first menu item keeps the token in the address.
    await page.getByRole('link', { name: 'Pricing' }).first().click();
    await expect(page).toHaveURL(/\/p\/v1\.[\w-]+\.[\w-]+#pricing$/);
    // No Content-Security-Policy violation was reported while the page and the click ran.
    expect(await page.evaluate(() => (globalThis as unknown as { __v?: string[] }).__v ?? [])).toEqual([]);
    expect(await prospect.cookies()).toEqual([]);

    // A one-character edit of the link is refused.
    const bad = await page.goto(link.replace(/(\/p\/.{12})./, '$1X'));
    expect(bad?.status()).toBe(404);
  } finally {
    await prospect.close();
  }
});

// P2 S8b (FR-TPL-09): the freelancer turns a link off; the prospect then sees it was withdrawn.
test('A turns a preview link off; the prospect sees it withdrawn, and a link that stays on keeps working', async ({
  browser,
}) => {
  await a.page.goto(`/w/${a.slug}/templates`);
  const card = a.page.locator('li', { has: a.page.getByRole('heading', { name: 'Taxi Quick' }) });
  const box = card.getByLabel('Preview link');
  const make = async (name: string) => {
    // The link box keeps showing the previous link until the new one arrives: wait for it to change.
    const before = (await box.count()) > 0 ? await box.inputValue() : '';
    await card.getByLabel('Business name').fill(name);
    await card.getByRole('button', { name: 'Create preview link' }).click();
    await expect(box).toBeVisible();
    await expect(box).not.toHaveValue(before);
    return await box.inputValue();
  };
  const toTurnOff = await make('Revoke Me Travels');
  const staysOn = await make('Keep Me Travels');

  // The list shows the links, newest first: the second row is the link made first.
  await expect(a.page.getByText('Active').first()).toBeVisible();
  const turnOffButtons = a.page.getByRole('button', { name: 'Turn off' });
  // Wait for the list to show all three links (the Gym link of the journey above and these two): until then a
  // click could land on a different row.
  await expect(turnOffButtons).toHaveCount(3);
  await turnOffButtons.nth(1).click(); // the older of the two: the first link made
  // An in-page confirmation (not the browser's confirm()): it names what will happen.
  const dialog = a.page.getByRole('dialog');
  await expect(dialog).toContainText('Turn off the link for Revoke Me Travels');
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  // Exact: the panel's footnote also contains the words "turned off", which would match at once.
  await expect(a.page.getByText('Turned off', { exact: true })).toHaveCount(1);

  const prospect = await browser.newContext();
  try {
    const page = await prospect.newPage();
    const gone = await page.goto(toTurnOff);
    expect(gone?.status()).toBe(410);
    await expect(page.getByRole('heading', { name: 'This preview link was withdrawn' })).toBeVisible();
    expect(await page.content()).not.toContain('Revoke Me Travels');
    const alive = await page.goto(staysOn);
    expect(alive?.status()).toBe(200);
    await expect(page.locator('.pb-brand').first()).toHaveText('Keep Me Travels');
  } finally {
    await prospect.close();
  }
});

test('the audit log names preview-link events, and the stored log holds neither the link nor the prospect', async () => {
  await a.page.goto(`/w/${a.slug}/audit`);
  await expect(a.page.getByText(/template\.preview_link\.created/).first()).toBeVisible();
  await expect(a.page.getByText(/template\.preview_link\.revoked/).first()).toBeVisible();
  // The page names the target for the people allowed to read it (joined from the workspace's own link list)...
  await expect(a.page.getByText(/link for Revoke Me Travels/).first()).toBeVisible();
  expect(await a.page.content()).not.toMatch(/\/p\/v1\./);
  // ...but the audit records themselves (the export) never contain the prospect or the link.
  const csv = await (await a.context.request.get(`/w/${a.slug}/audit/export`)).text();
  expect(csv).toContain('template.preview_link.revoked');
  expect(csv).not.toContain('Revoke Me Travels');
  expect(csv).not.toContain('Sharma Fitness');
  expect(csv).not.toMatch(/\/p\/v1\./);
});

// P3 S3 (FR-PRJ-01, FR-BLD-01/02/06): the editor. A starts the project's site from a template, edits the business name,
// sees it autosaved and in the live preview, and undoes it. The preview is rendered by the dashboard (Owner decision
// 2026-11-15) and may be framed by the dashboard only; no other dashboard page may be framed at all.
test('A starts the site from a template, edits it with autosave and live preview, and undoes the change', async () => {
  test.setTimeout(180_000);
  const page = a.page;
  await page.goto(`/w/${a.slug}/projects/${projectId}`);
  await page.getByRole('link', { name: 'Edit site' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a template' })).toBeVisible();
  await page.getByRole('button', { name: 'Start with Gym Bold' }).click();
  await page.waitForURL(/\/editor$/);
  await expect(page.getByRole('heading', { name: 'Business details', level: 2 })).toBeVisible();

  const preview = page.frameLocator('iframe[title="Site preview"]');
  await expect(preview.locator('h1').first()).toBeVisible();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  const before = await name.inputValue();
  const renamed = `Pulse ${run}`;
  // The lock is taken on open; editing is enabled once the heartbeat confirms it.
  await expect(name).toBeEnabled({ timeout: 30_000 });
  await name.fill(renamed);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 30_000 });
  await expect(preview.getByText(renamed).first()).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Undone', { timeout: 30_000 });
  await expect(name).toHaveValue(before);
  await expect(preview.getByText(before).first()).toBeVisible();
});

test('the preview may be framed by the dashboard only and runs no script; the editor page cannot be framed', async () => {
  const editor = await a.page.request.get(`/w/${a.slug}/projects/${projectId}/editor`);
  expect(editor.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(editor.headers()['x-frame-options']).toBe('DENY');
  const preview = await a.page.request.get(`/editor-preview/${a.slug}/${projectId}`);
  expect(preview.status()).toBe(200);
  const csp = preview.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain('script-src');
  expect(csp).not.toContain("frame-ancestors 'none'");
  expect(preview.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect(preview.headers()['x-robots-tag']).toContain('noindex');
  expect(await preview.text()).not.toMatch(/<script/i);
});

test("B cannot open A's editor or A's draft preview", async () => {
  const editor = await b.page.goto(`/w/${a.slug}/projects/${projectId}/editor`);
  expect(editor?.status()).toBe(404);
  const preview = await b.page.request.get(`/editor-preview/${a.slug}/${projectId}`);
  expect(preview.status()).toBe(404);
  // Through B's own workspace slug, A's project id is not found either.
  const viaOwn = await b.page.request.get(`/editor-preview/${b.slug}/${projectId}`);
  expect(viaOwn.status()).toBe(404);
});

// P2 (NFR-A11Y-01: WCAG 2.1 AA for the dashboard and the reference templates): the dashboard pages a freelancer uses
// every day, signed in, with data on them.
test('the dashboard pages pass axe (WCAG 2.1 A and AA)', async () => {
  // Eleven pages on a development server that compiles each on first use (P3 S3 added the editor).
  test.setTimeout(300_000);
  const pages = [
    `/w/${a.slug}`,
    `/w/${a.slug}/projects`,
    `/w/${a.slug}/projects/new`,
    `/w/${a.slug}/projects/${projectId}`,
    `/w/${a.slug}/projects/${projectId}/editor`,
    `/w/${a.slug}/templates`,
    `/w/${a.slug}/members`,
    `/w/${a.slug}/notifications`,
    `/w/${a.slug}/audit`,
    `/w/${a.slug}/settings`,
    `/settings/security`,
  ];
  const found: string[] = [];
  for (const path of pages) {
    await a.page.goto(path);
    await expect(a.page.locator('main, h1').first()).toBeVisible();
    // The editor's preview iframe holds template content, which tests/quality checks for every template and block
    // (a11y.spec.ts); here the dashboard's own UI is under test.
    const result = await new AxeBuilder({ page: a.page })
      .exclude('iframe[title="Site preview"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of result.violations) {
      found.push(
        `${path} ${v.id} (${v.impact}): ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
      );
    }
  }
  expect(found).toEqual([]);
});

test('the public pages pass axe: sign-in and sign-up', async ({ page }) => {
  const found: string[] = [];
  for (const path of ['/sign-in', '/sign-up']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of result.violations) {
      found.push(
        `${path} ${v.id} (${v.impact}): ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
      );
    }
  }
  expect(found).toEqual([]);
});
