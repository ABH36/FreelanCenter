// Lighthouse mobile budgets on the three built-in templates (SRS NFR-PERF-01, NFR-A11Y; Phase 2 exit):
// performance >= 90, accessibility >= 95, SEO >= 95, best practices >= 95; median of RUNS runs per template.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { request } from 'node:http';
import lighthouse from 'lighthouse';

const get = (path, host) =>
  new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: PORT, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    })
      .on('error', reject)
      .end();
  });

const PORT = Number(process.env.QUALITY_PORT ?? 4010);
const RUNS = Number(process.env.LH_RUNS ?? 3);
const SLUGS = ['gym-bold', 'taxi-quick', 'wedding-royal'];
const BUDGET = { performance: 90, accessibility: 95, seo: 95, 'best-practices': 95 };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const server = spawn(process.execPath, ['.cache/serve.mjs'], {
  env: { ...process.env, QUALITY_PORT: String(PORT) },
  stdio: 'ignore',
});
const chrome = spawn(
  chromium.executablePath(),
  [
    '--headless=new',
    '--remote-debugging-port=9333',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lh-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const stop = () => {
  server.kill();
  chrome.kill();
};
await sleep(3000);

const report = {};
let failed = false;
try {
  for (const slug of SLUGS) {
    // Lighthouse fetches robots.txt through the page, where our strict CSP (default-src 'none', SEC-03) blocks it:
    // a measurement artefact, not a site fault. The audit is skipped and the file is checked directly instead.
    const robots = await get(`/robots.txt`, `${slug}.quality.localhost:${PORT}`);
    const robotsText = robots.body;
    if (
      robots.status !== 200 ||
      !/^User-agent: \*/m.test(robotsText) ||
      !/^Sitemap: https?:\/\//m.test(robotsText)
    ) {
      failed = true;
      process.stderr.write(`FAIL ${slug}: robots.txt is not valid
`);
    }
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      const r = await lighthouse(`http://${slug}.quality.localhost:${PORT}/`, {
        port: 9333,
        output: 'json',
        logLevel: 'error',
        onlyCategories: Object.keys(BUDGET),
        skipAudits: ['robots-txt'],
      });
      const c = r.lhr.categories;
      runs.push({
        ...Object.fromEntries(Object.keys(BUDGET).map((k) => [k, Math.round((c[k].score ?? 0) * 100)])),
        lcpMs: Math.round(r.lhr.audits['largest-contentful-paint'].numericValue),
        cls: Number(r.lhr.audits['cumulative-layout-shift'].numericValue.toFixed(3)),
        tbtMs: Math.round(r.lhr.audits['total-blocking-time'].numericValue),
        failing: Object.values(r.lhr.audits)
          .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode === 'numeric')
          .map((a) => a.id),
      });
    }
    const row = Object.fromEntries(
      [...Object.keys(BUDGET), 'lcpMs', 'cls', 'tbtMs'].map((k) => [k, median(runs.map((x) => x[k]))]),
    );
    row.failing = [...new Set(runs.flatMap((x) => x.failing))];
    report[slug] = row;
    for (const [k, min] of Object.entries(BUDGET)) {
      if (row[k] < min) {
        failed = true;
        process.stderr.write(`FAIL ${slug}: ${k} ${row[k]} < ${min}
`);
      }
    }
    process.stdout.write(`${slug} ${JSON.stringify(row)}
`);
  }
} finally {
  stop();
}
mkdirSync('.cache', { recursive: true });
writeFileSync('.cache/lighthouse.json', JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
