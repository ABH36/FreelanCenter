/** WCAG 2.1 A/AA on every built-in template (SRS NFR-A11Y, FR-TPL): zero axe violations, mobile and desktop. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PORT, SLUGS } from '../playwright.config';

for (const slug of SLUGS) {
  test(`@a11y ${slug}: no axe violations`, async ({ page }) => {
    await page.goto(`http://${slug}.quality.localhost:${PORT}/`);
    await page.evaluate(() => document.fonts.ready);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const summary = result.violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 5)
          .join(' | ')}`,
    );
    expect(summary).toEqual([]);
  });
}
