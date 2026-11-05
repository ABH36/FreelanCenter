import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildJsonSchemas } from './index';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'json-schema');
const render = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe('JSON Schema export (FR-TPL-01)', () => {
  const built = buildJsonSchemas();

  it('generates a draft 2020-12 document per contract', () => {
    expect(Object.keys(built).sort()).toEqual([
      'patch.schema.json',
      'site-config.schema.json',
      'template.schema.json',
    ]);
    for (const v of Object.values(built)) expect((v as { $schema: string }).$schema).toContain('2020-12');
  });
  it('is closed: strict objects export additionalProperties false', () => {
    expect(JSON.stringify(built['site-config.schema.json'])).toContain('"additionalProperties":false');
  });
  it('committed files match the Zod schemas (regenerate with UPDATE_JSON_SCHEMA=1)', () => {
    if (process.env['UPDATE_JSON_SCHEMA'] === '1') {
      mkdirSync(dir, { recursive: true });
      for (const [name, schema] of Object.entries(built)) writeFileSync(join(dir, name), render(schema));
    }
    for (const [name, schema] of Object.entries(built)) {
      expect(readFileSync(join(dir, name), 'utf8')).toBe(render(schema));
    }
  });
});
