import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSeed, canonicalJson, contentHash, renderSeed } from './seed';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');
const file = join(dir, 'builtin-templates.json');

/** The same golden value is asserted by packages/db: the two implementations of the hash must agree. */
export const GOLDEN = {
  config: { b: [1, { z: true, a: null }], a: 'x', c: { y: 2, x: 1 } },
  manifest: { fields: [] },
  hash: '2a4726d0b8b43847d0b1fb9f2cc0fba58d32ea18d2cd532a3feea1e3a880c94b',
};

describe('seed file (reviewable content of the built-in templates)', () => {
  it('canonical JSON sorts keys at every level and the hash is stable', () => {
    expect(canonicalJson(GOLDEN.config)).toBe('{"a":"x","b":[1,{"a":null,"z":true}],"c":{"x":1,"y":2}}');
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(contentHash({ a: 1, b: 2 }, {})).toBe(contentHash({ b: 2, a: 1 }, {}));
    expect(contentHash(GOLDEN.config, GOLDEN.manifest)).toBe(GOLDEN.hash);
  });

  it('builds a valid seed with one entry per built-in template, each with a distinct hash', () => {
    const seed = buildSeed();
    expect(seed.format).toBe(1);
    expect(seed.templates.map((t) => t.slug)).toEqual(['gym-bold', 'taxi-quick', 'wedding-royal']);
    expect(new Set(seed.templates.map((t) => t.contentHash)).size).toBe(3);
    for (const t of seed.templates) {
      expect(t.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      expect(t.schemaVersion).toBe('1.0');
      expect(t.contentHash).toBe(contentHash(t.config, t.manifest));
      expect(JSON.stringify(t.config).length).toBeLessThan(262_144);
      expect(JSON.stringify(t.manifest).length).toBeLessThan(65_536);
    }
  });

  it('the committed file matches the template definitions (regenerate with UPDATE_TEMPLATE_SEED=1)', () => {
    if (process.env['UPDATE_TEMPLATE_SEED'] === '1') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, renderSeed(buildSeed()));
    }
    expect(readFileSync(file, 'utf8')).toBe(renderSeed(buildSeed()));
  });
});
