/**
 * Seeding the built-in templates (P2 S5b). The seed file `packages/templates/seed/builtin-templates.json` is
 * generated and validated by `@platform/templates` (full `templateSchema`); this module re-checks what the database
 * cannot (shape, content hash) and applies it through the operator function, as `migrator`, in one transaction.
 * Idempotent: an unchanged template creates no new version. Nothing here trusts the file blindly: a hash that does
 * not match the content, an unknown key or an oversized document stops the run before any statement is sent.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';

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
export interface SeedOutcome {
  slug: string;
  templateId: string;
  version: number;
  created: boolean;
}

const MAX_TEMPLATES = 100;
const KEYS = [
  'category',
  'config',
  'contentHash',
  'description',
  'manifest',
  'name',
  'schemaVersion',
  'slug',
];

/** JSON with object keys sorted at every level, no whitespace. Twin of `canonicalJson` in @platform/templates. */
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

/** Throws a plain-language error for anything that is not a well-formed, untampered seed file. */
export function verifySeed(input: unknown): SeedFile {
  if (typeof input !== 'object' || input === null) throw new Error('Seed file is not an object');
  const seed = input as { format?: unknown; templates?: unknown };
  if (seed.format !== 1) throw new Error('Unsupported seed file format');
  if (
    !Array.isArray(seed.templates) ||
    seed.templates.length === 0 ||
    seed.templates.length > MAX_TEMPLATES
  ) {
    throw new Error(`Seed file must list 1 to ${MAX_TEMPLATES} templates`);
  }
  const slugs = new Set<string>();
  for (const raw of seed.templates as unknown[]) {
    if (typeof raw !== 'object' || raw === null) throw new Error('A seed template is not an object');
    const t = raw as Record<string, unknown>;
    const keys = Object.keys(t).sort();
    if (JSON.stringify(keys) !== JSON.stringify(KEYS))
      throw new Error(`Seed template has unexpected keys: ${keys.join(', ')}`);
    for (const k of ['slug', 'name', 'category', 'description', 'schemaVersion', 'contentHash'] as const) {
      if (typeof t[k] !== 'string') throw new Error(`Seed template field ${k} must be text`);
    }
    const slug = t['slug'] as string;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error(`Invalid slug: ${slug}`);
    if (slugs.has(slug)) throw new Error(`Duplicate slug: ${slug}`);
    slugs.add(slug);
    for (const k of ['config', 'manifest'] as const) {
      const v = t[k];
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        throw new Error(`${slug}: ${k} must be an object`);
    }
    if (contentHash(t['config'], t['manifest']) !== t['contentHash']) {
      throw new Error(`${slug}: content hash does not match the content (the file was edited or is stale)`);
    }
  }
  return input as SeedFile;
}

/**
 * Applies the seed with one `migrator` connection in a single transaction: all templates or none. The database
 * function writes the audit rows and serialises concurrent runs per slug.
 */
export async function applySeed(client: pg.ClientBase, seed: SeedFile): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  await client.query('BEGIN');
  try {
    for (const t of seed.templates) {
      const { rows } = await client.query<{ template_id: string; version: number; created: boolean }>(
        'SELECT * FROM app.operator_publish_builtin_template($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)',
        [
          t.slug,
          t.name,
          t.category,
          t.description,
          t.schemaVersion,
          JSON.stringify(t.config),
          JSON.stringify(t.manifest),
          t.contentHash,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error(`${t.slug}: the database returned no result`);
      outcomes.push({
        slug: t.slug,
        templateId: row.template_id,
        version: row.version,
        created: row.created,
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return outcomes;
}
