/**
 * Font pipeline evidence (Q19, P2 S2): the copy script ships exactly the files the policy in @platform/ui names, and
 * the byte budgets that the policy rests on hold. The measured table is recorded in docs/reports/PHASE_2_S2_*.md.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FONTS } from '@platform/schema';
import { FONT_SLUGS, fontFiles, themePreloads } from '@platform/ui';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without types
import { FONT_SLUGS as SCRIPT_SLUGS, copyFonts } from '../scripts/copy-fonts.mjs';

const out = mkdtempSync(join(tmpdir(), 'fonts-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const size = (file: string) => statSync(join(out, file)).size;
const KB = 1024;

describe('font files', () => {
  const copied = copyFonts(out) as number;

  it('the script and the policy name the same fonts', () => {
    expect([...(SCRIPT_SLUGS as string[])].sort()).toEqual([...FONT_SLUGS].sort());
  });
  it('ships every file the policy declares, and nothing else', () => {
    const expected = FONTS.flatMap((f) => fontFiles(f.name));
    expect(copied).toBe(expected.length);
    expect(readdirSync(out).sort()).toEqual([...expected].sort());
  });
  it('Latin critical path (body 400 + heading 700 preload) is at most 50 KB for every pair', () => {
    let worst = 0;
    for (const body of FONTS) {
      for (const heading of FONTS) {
        const files = themePreloads({
          typography: { heading: heading.name, body: body.name, scale: 'comfortable' },
        }).map((p) => p.replace('/fonts/', ''));
        worst = Math.max(
          worst,
          files.reduce((n, f) => n + size(f), 0),
        );
      }
    }
    expect(worst).toBeLessThanOrEqual(50 * KB);
  });
  it('a Devanagari page costs at most 220 KB of font bytes for the heaviest allowed pair, 100 KB for the lightest family', () => {
    const dev = FONTS.filter((f) => f.devanagari).map((f) => f.name);
    const bytes = (name: (typeof dev)[number]) =>
      fontFiles(name as (typeof FONTS)[number]['name'])
        .filter((f) => f.includes('devanagari'))
        .reduce((n, f) => n + size(f), 0);
    expect(Math.max(...dev.map(bytes))).toBeLessThanOrEqual(220 * KB);
    expect(Math.min(...dev.map(bytes))).toBeLessThanOrEqual(100 * KB);
  });
});
