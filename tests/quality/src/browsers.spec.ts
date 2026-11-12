/**
 * NFR-BROW-01 (latest Chrome, Edge, Safari, Firefox; Android Chrome; iOS Safari 16+): the same pages in Firefox and in
 * WebKit on an iPhone profile. Chromium (Chrome, Edge, Android Chrome) is covered by the other specs. Each page must
 * render its content, load its own fonts, fit the screen, break no Content-Security-Policy rule and pass axe.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PORT, SLUGS } from '../playwright.config';

for (const slug of SLUGS) {
  for (const path of ['', 'all-blocks']) {
    test(`@browser ${slug}${path ? ' ' + path : ''}: renders, fits, fonts load, no CSP violations, axe clean`, async ({
      page,
    }) => {
      await page.addInitScript(
        "document.addEventListener('securitypolicyviolation', (e) => { (globalThis.__csp ??= []).push(e.violatedDirective); });",
      );
      const failed: string[] = [];
      page.on('requestfailed', (r) => failed.push(r.url()));
      const res = await page.goto(`http://${slug}.quality.localhost:${PORT}/${path}`);
      expect(res?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);

      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('header').first()).toBeVisible();
      await expect(page.locator('footer')).toBeVisible();

      // Fits the screen: nothing sideways (320 CSS px is the narrowest supported width, WCAG 1.4.10).
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The self-hosted fonts of the theme were really used (not only the fallback stack).
      const loaded = await page.evaluate(() =>
        Array.from(document.fonts as unknown as Iterable<{ status: string; family: string }>)
          .filter((f) => f.status === 'loaded')
          .map((f) => f.family),
      );
      expect(loaded.length).toBeGreaterThan(0);

      expect(await page.evaluate(() => (globalThis as unknown as { __csp?: string[] }).__csp ?? [])).toEqual(
        [],
      );
      expect(failed).toEqual([]);

      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    });
  }
}

test('@browser the menu opens and closes with the keyboard on the home page', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the collapsed menu only exists on small screens');
  await page.goto(`http://gym-bold.quality.localhost:${PORT}/`);
  const summary = page.locator('.pb-nav__mobile summary');
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.pb-nav__mobile[open] a').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.pb-nav__mobile[open]')).toHaveCount(0);
});
