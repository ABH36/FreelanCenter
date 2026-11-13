/**
 * Accessibility behaviour that axe does not judge: reduced motion, forced colours (Windows high contrast), reflow at
 * 320 CSS px (WCAG 1.4.10, which is what 400 % zoom on a 1280 px screen gives), and keyboard-only use (2.1.1, 2.4.7).
 */
import { expect, test } from '@playwright/test';
import { PORT, SLUGS } from '../playwright.config';

for (const slug of SLUGS) {
  const url = `http://${slug}.quality.localhost:${PORT}/all-blocks`;

  test(`@a11y ${slug}: prefers-reduced-motion switches every animation and transition off`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(url);
    const moving = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .filter((el) => {
          const s = getComputedStyle(el);
          const ms = (v: string) =>
            Math.max(...v.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000)));
          return (s.animationName !== 'none' && ms(s.animationDuration) > 1) || ms(s.transitionDuration) > 1;
        })
        .slice(0, 5)
        .map((el) => el.tagName + '.' + el.className),
    );
    expect(moving).toEqual([]);
  });

  test(`@a11y ${slug}: forced colours keep buttons and links distinguishable`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(url);
    const flat = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[class*="pb-btn"], button'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) < 1)
        .slice(0, 5)
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(flat).toEqual([]);
  });

  test(`@a11y ${slug}: reflows at 320 CSS px with no horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(url);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test(`@a11y ${slug}: keyboard only - skip link first, visible focus, no trap`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium');
    await page.goto(`http://${slug}.quality.localhost:${PORT}/`);
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() =>
      (document.activeElement as HTMLAnchorElement).getAttribute('href'),
    );
    expect(first).toMatch(/^#/);
    const seen = new Set<string>();
    const hidden: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const s = getComputedStyle(el);
        const ring = parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none';
        return {
          id: `${el.tagName}:${el.getAttribute('href') ?? el.textContent?.slice(0, 20)}`,
          ring,
          shadow: s.boxShadow !== 'none',
        };
      });
      // Focus left the page for the browser's own controls (Tab wrapped round): not a page stop.
      if (info.id.startsWith('BODY')) continue;
      seen.add(info.id);
      if (!info.ring && !info.shadow) hidden.push(info.id);
    }
    expect(hidden).toEqual([]);
    // Focus keeps moving through the page (no trap): many different stops.
    expect(seen.size).toBeGreaterThan(8);
  });
}

// Acceptance run 4 (R-1): laptop and tablet-landscape widths keep normal page padding and the business name whole.
for (const slug of SLUGS) {
  for (const width of [900, 1024, 1180, 1280]) {
    test(`@a11y ${slug}: at ${width} px the page keeps normal padding and the full business name`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`http://${slug}.quality.localhost:${PORT}/`);
      const m = await page.evaluate(() => {
        const c = document.querySelector('main .pb-container') as HTMLElement;
        const s = getComputedStyle(c);
        const brand = document.querySelector('.pb-header .pb-brand') as HTMLElement;
        return {
          left: parseFloat(s.paddingLeft),
          right: parseFloat(s.paddingRight),
          brandCut: brand.scrollWidth > brand.clientWidth + 1,
        };
      });
      expect(m.left).toBeLessThanOrEqual(24);
      expect(m.right).toBeLessThanOrEqual(96);
      expect(m.brandCut).toBe(false);
    });
  }
}
