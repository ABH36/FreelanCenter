/**
 * Visual regression: the full home page of each built-in template and the gallery of every block variant under its
 * theme. Baselines are made in the Linux Playwright image (see scripts/visual-baselines.sh).
 */
import { expect, test } from '@playwright/test';
import { PORT, SLUGS } from '../playwright.config';

for (const slug of SLUGS) {
  for (const path of ['', 'all-blocks']) {
    test(`@visual ${slug}${path ? ' ' + path : ''}`, async ({ page }) => {
      await page.goto(`http://${slug}.quality.localhost:${PORT}/${path}`);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${slug}${path ? '-' + path : ''}.png`, { fullPage: true });
    });
  }
}
