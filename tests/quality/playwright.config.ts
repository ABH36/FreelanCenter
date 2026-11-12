import { defineConfig, devices } from '@playwright/test';

export const PORT = Number(process.env.QUALITY_PORT ?? 4010);
export const SLUGS = ['gym-bold', 'taxi-quick', 'wedding-royal'] as const;
/** The same sites in Hindi (`<slug>-hi`); every block variant is on `/gallery` of each site. */
export const ALL_SITES = [...SLUGS, ...SLUGS.map((s) => `${s}-hi` as const)] as const;

export default defineConfig({
  testDir: 'src',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{projectName}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' } },
  webServer: {
    command: 'node .cache/serve.mjs',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    env: { QUALITY_PORT: String(PORT) },
  },
  projects: [
    { name: 'mobile', grepInvert: /@browser/, use: { ...devices['Pixel 7'] } },
    {
      name: 'desktop',
      grepInvert: /@browser/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    // NFR-BROW-01: Firefox, and WebKit (the engine of Safari and every iOS browser) on a phone. Only the @browser
    // smoke and accessibility checks run here; screenshots are Chromium-only.
    { name: 'firefox', grep: /@browser/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-mobile', grep: /@browser/, use: { ...devices['iPhone 13'] } },
  ],
});
