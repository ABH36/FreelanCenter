/**
 * WCAG 2.1 A/AA on the three built-in templates and on a gallery of every block variant under each template's theme,
 * in English and Hindi, mobile and desktop (SRS NFR-A11Y, FR-TPL): zero axe violations.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ALL_SITES, PORT, SLUGS } from '../playwright.config';

async function violations(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 5)
        .join(' | ')}`,
  );
}

for (const slug of SLUGS) {
  test(`@a11y ${slug}: no axe violations`, async ({ page }) => {
    await page.goto(`http://${slug}.quality.localhost:${PORT}/`);
    expect(await violations(page)).toEqual([]);
  });
}

const TONES = ['', '-surface', '-primary', '-secondary', '-accent'] as const;

for (const slug of ALL_SITES) {
  for (const tone of TONES) {
    test(`@a11y ${slug}: every block variant${tone ? ' on a ' + tone.slice(1) + ' band' : ''}, no axe violations`, async ({
      page,
    }) => {
      await page.goto(`http://${slug}.quality.localhost:${PORT}/all-blocks${tone}`);
      expect(await page.locator('main section').count()).toBeGreaterThanOrEqual(24);
      expect(await violations(page)).toEqual([]);
    });
  }
}
