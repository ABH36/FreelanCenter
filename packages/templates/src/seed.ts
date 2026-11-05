/**
 * The seed file (`seed/builtin-templates.json`): every built-in template, validated with the real `templateSchema`
 * and hashed, as plain JSON. It is committed so a change to a template's content is a reviewable diff in a pull
 * request, and it is what `pnpm --filter @platform/db db:seed-templates` writes into the database through the
 * operator function. `seed.test.ts` fails when the file and the template definitions disagree.
 *
 * `canonicalJson` and `contentHash` have a twin in `packages/db/src/seed-templates.ts` (the db package cannot import
 * this one); a golden hash in both test suites keeps the two identical.
 */
import { createHash } from 'node:crypto';
import { templateSchema } from '@platform/schema';
import { BUILT_IN_TEMPLATES } from './index';

export interface SeedTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  schemaVersion: string;
  config: unknown;
  manifest: unknown;
  contentHash: string;
}

export interface SeedFile {
  format: 1;
  templates: SeedTemplate[];
}

/** JSON with object keys sorted at every level, no whitespace: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export const contentHash = (config: unknown, manifest: unknown): string =>
  createHash('sha256').update(canonicalJson({ config, manifest })).digest('hex');

export function buildSeed(): SeedFile {
  const templates = BUILT_IN_TEMPLATES.map((definition): SeedTemplate => {
    const parsed = templateSchema.safeParse(definition);
    if (!parsed.success) {
      throw new Error(
        `Template ${definition.id} is invalid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
      );
    }
    const t = parsed.data;
    return {
      slug: t.id,
      name: t.name,
      category: t.category,
      description: t.description,
      schemaVersion: t.config.schemaVersion,
      config: t.config,
      manifest: t.manifest,
      contentHash: contentHash(t.config, t.manifest),
    };
  });
  return { format: 1, templates };
}

export const renderSeed = (seed: SeedFile): string => `${JSON.stringify(seed, null, 2)}\n`;
