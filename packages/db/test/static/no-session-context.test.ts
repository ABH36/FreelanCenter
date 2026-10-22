/**
 * Static guard for SRS 5.3 item 3: tenant context is only ever set transaction-locally.
 * Scans product source (apps and packages, not spikes or tests, which demonstrate the anti-pattern on purpose).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCANNED = ['apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'generated',
  'coverage',
  '.turbo',
  'test',
  '__tests__',
]);

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bSET\s+(SESSION\s+)?app\.[a-z_]+/i, 'session-level SET of an app.* setting'],
  [/set_config\(\s*'app\.[a-z_]+'\s*,[^)]*,\s*false\s*\)/i, "set_config('app.*', ..., false)"],
  [/\$extends\(\s*\{\s*query\s*:/, 'per-query Prisma extension (use withTenant: Spike B B-4/B-5)'],
];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts|mjs|js|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

describe('tenant context is transaction-local only', () => {
  it('no product source sets app.* at session level', () => {
    const offences: string[] = [];
    let scanned = 0;
    for (const top of SCANNED) {
      for (const file of sourceFiles(join(ROOT, top))) {
        scanned++;
        const text = readFileSync(file, 'utf8');
        for (const [pattern, label] of FORBIDDEN) {
          if (pattern.test(text)) offences.push(`${relative(ROOT, file)}: ${label}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(10);
    expect(offences).toEqual([]);
  });

  it('the patterns do catch the anti-patterns', () => {
    expect(FORBIDDEN[0]![0].test("await db.$executeRaw`SET app.workspace_id = '1'`")).toBe(true);
    expect(FORBIDDEN[1]![0].test("SELECT set_config('app.workspace_id', $1, false)")).toBe(true);
    expect(FORBIDDEN[1]![0].test("SELECT set_config('app.workspace_id', $1, true)")).toBe(false);
  });
});
