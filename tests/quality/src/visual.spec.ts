/** Visual regression: the full page of each built-in template. Baselines are made in the Linux Playwright image. */
import { expect, test } from '@playwright/test';
import { PORT, SLUGS } from '../playwright.config';

for (const slug of SLUGS) {
  test(`@visual ${slug}`, async ({ page }) => {
    await page.goto(`http://${slug}.quality.localhost:${PORT}/`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${slug}.png`, { fullPage: true });
  });
}
