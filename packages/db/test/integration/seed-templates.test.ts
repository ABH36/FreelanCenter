/**
 * P2 S5b: the seed command's logic against the real database and the committed seed file. The golden hash is the
 * same value @platform/templates asserts: the two implementations of the content hash must agree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySeed, canonicalJson, contentHash, verifySeed, type SeedFile } from '../../src/seed-templates';
import { pool, urls } from './helpers';

const FILE = fileURLToPath(new URL('../../../templates/seed/builtin-templates.json', import.meta.url));
const real = (): SeedFile => JSON.parse(readFileSync(FILE, 'utf8')) as SeedFile;

let migrator: pg.Pool;
let visitor: pg.Pool;
beforeAll(() => {
  migrator = pool(urls.migrator, 2);
  visitor = pool(urls.public, 1);
});
afterAll(async () => {
  await Promise.all([migrator.end(), visitor.end()]);
});

describe('content hash', () => {
  it('matches the golden value of @platform/templates', () => {
    const config = { b: [1, { z: true, a: null }], a: 'x', c: { y: 2, x: 1 } };
    expect(canonicalJson(config)).toBe('{"a":"x","b":[1,{"a":null,"z":true}],"c":{"x":1,"y":2}}');
    expect(contentHash(config, { fields: [] })).toBe(
      '2a4726d0b8b43847d0b1fb9f2cc0fba58d32ea18d2cd532a3feea1e3a880c94b',
    );
  });
});

describe('verifySeed', () => {
  it('accepts the committed seed file: three built-in templates with matching hashes', () => {
    const seed = verifySeed(real());
    expect(seed.templates.map((t) => t.slug)).toEqual(['gym-bold', 'taxi-quick', 'wedding-royal']);
  });

  it('refuses tampered, malformed and oversized input before anything is sent', () => {
    const bad = (mutate: (s: SeedFile) => void) => {
      const s = structuredClone(real());
      mutate(s);
      return () => verifySeed(s);
    };
    expect(bad((s) => ((s.templates[0]!.config as Record<string, unknown>)['tampered'] = 1))).toThrow(
      /content hash/,
    );
    expect(bad((s) => (s.templates[0]!.slug = 'Bad Slug'))).toThrow(/Invalid slug/);
    expect(bad((s) => (s.templates[1]!.slug = s.templates[0]!.slug))).toThrow(/Duplicate slug/);
    expect(bad((s) => ((s.templates[0] as unknown as Record<string, unknown>)['extra'] = 1))).toThrow(
      /unexpected keys/,
    );
    expect(bad((s) => (s.templates = []))).toThrow(/1 to 100/);
    expect(bad((s) => ((s as unknown as Record<string, unknown>)['format'] = 2))).toThrow(/format/);
    expect(bad((s) => ((s.templates[0] as unknown as Record<string, unknown>)['config'] = []))).toThrow(
      /must be an object/,
    );
    expect(() => verifySeed(null)).toThrow();
    expect(() => verifySeed('x')).toThrow();
  });
});

describe('applySeed against the database', () => {
  it('writes the three built-ins, is a no-op the second time, and exposes them through the catalogue', async () => {
    const seed = verifySeed(real());
    const client = await migrator.connect();
    try {
      const first = await applySeed(client, seed);
      expect(first.map((o) => o.slug)).toEqual(['gym-bold', 'taxi-quick', 'wedding-royal']);
      const second = await applySeed(client, seed);
      expect(second.every((o) => !o.created)).toBe(true);
      expect(second.map((o) => o.version)).toEqual(first.map((o) => o.version));
      expect(second.map((o) => o.templateId)).toEqual(first.map((o) => o.templateId));
    } finally {
      client.release();
    }
    const { rows } = await visitor.query(
      `SELECT slug, category FROM app.list_catalog_templates() WHERE slug IN ('gym-bold','taxi-quick','wedding-royal') ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: 'gym-bold', category: 'gym' },
      { slug: 'taxi-quick', category: 'taxi' },
      { slug: 'wedding-royal', category: 'wedding-event' },
    ]);
  });

  it('all or nothing: one bad template rolls the whole run back', async () => {
    const seed = structuredClone(verifySeed(real()));
    const probe = { ...seed.templates[0]!, slug: `rollback-${Date.now().toString(36)}`.slice(0, 40) };
    const broken = {
      ...seed.templates[1]!,
      slug: `broken-${Date.now().toString(36)}`.slice(0, 40),
      category: 'spaceship',
    };
    const client = await migrator.connect();
    try {
      await expect(applySeed(client, { format: 1, templates: [probe, broken] })).rejects.toThrow();
    } finally {
      client.release();
    }
    const { rows } = await visitor.query(`SELECT 1 FROM app.list_catalog_templates() WHERE slug = $1`, [
      probe.slug,
    ]);
    expect(rows).toEqual([]);
  });

  it('the catalogue serves the exact validated content of the seed file', async () => {
    const seed = verifySeed(real());
    const gym = seed.templates.find((t) => t.slug === 'gym-bold')!;
    const { rows: listed } = await visitor.query(
      `SELECT template_id FROM app.list_catalog_templates() WHERE slug = 'gym-bold'`,
    );
    const { rows } = await visitor.query(
      `SELECT config, manifest, content_hash FROM app.get_catalog_template($1::uuid)`,
      [listed[0].template_id],
    );
    expect(canonicalJson(rows[0].config)).toBe(canonicalJson(gym.config));
    expect(rows[0].content_hash).toBe(gym.contentHash);
  });
});

describe('PublicDatabase.getCatalogTemplate (the preview route reads this)', () => {
  it('returns a published built-in with its content, a requested version, and null for anything else', async () => {
    const { createPublicDatabase } = await import('../../src/public');
    const pub = createPublicDatabase({ connectionString: urls.public });
    try {
      const { rows } = await visitor.query(
        `SELECT template_id FROM app.list_catalog_templates() WHERE slug = 'taxi-quick'`,
      );
      const id = rows[0].template_id as string;
      const latest = await pub.getCatalogTemplate(id);
      expect(latest).toMatchObject({
        templateId: id,
        slug: 'taxi-quick',
        category: 'taxi',
        visibility: 'platform',
        version: 1,
        schemaVersion: '1.0',
      });
      expect(canonicalJson(latest!.config)).toBe(
        canonicalJson(verifySeed(real()).templates.find((t) => t.slug === 'taxi-quick')!.config),
      );
      expect((await pub.getCatalogTemplate(id, 1))?.version).toBe(1);
      expect(await pub.getCatalogTemplate(id, 99)).toBeNull();
      expect(await pub.getCatalogTemplate('00000000-0000-7000-8000-000000000000')).toBeNull();
    } finally {
      await pub.close();
    }
  });
});
