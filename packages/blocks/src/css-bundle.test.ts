/**
 * `css-bundle.ts` is the static stylesheet (blocks.css) as a string so route handlers can inline it without file
 * tracing. Regenerate with `UPDATE_CSS_BUNDLE=1 pnpm --filter @platform/blocks test`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCKS_CSS } from './css-bundle';

const dir = dirname(fileURLToPath(import.meta.url));

/** Comment removal and whitespace folding only; values and selectors are untouched. */
export function minify(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([{};])\s*/g, '$1')
    .trim();
}

const render = (css: string) =>
  `/* Generated from blocks.css by css-bundle.test.ts (UPDATE_CSS_BUNDLE=1). Do not edit. */\nexport const BLOCKS_CSS = ${JSON.stringify(css)};\n`;

describe('css bundle', () => {
  const source = minify(readFileSync(join(dir, 'blocks.css'), 'utf8'));
  it('matches blocks.css (regenerate with UPDATE_CSS_BUNDLE=1)', () => {
    if (process.env['UPDATE_CSS_BUNDLE'] === '1') writeFileSync(join(dir, 'css-bundle.ts'), render(source));
    expect(BLOCKS_CSS).toBe(source);
  });
  it('is small, balanced and free of anything that could break out of a style element', () => {
    expect(BLOCKS_CSS.length).toBeGreaterThan(5000);
    expect(BLOCKS_CSS.length).toBeLessThan(30000);
    expect(BLOCKS_CSS.split('{').length).toBe(BLOCKS_CSS.split('}').length);
    expect(BLOCKS_CSS).not.toMatch(/<\/style|@import|url\(|expression\(|javascript:/i);
  });
});
