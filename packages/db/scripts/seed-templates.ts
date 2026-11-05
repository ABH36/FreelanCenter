/**
 * Writes the built-in templates (P2 S5b) into the database of one environment through
 * `app.operator_publish_builtin_template`, as `migrator`. The input is the committed, validated seed file of
 * `@platform/templates`. Idempotent; a changed template appends a new immutable version, an unchanged one is a no-op.
 *
 *   node scripts/seed-templates.ts --target local            # Docker stack
 *   node scripts/seed-templates.ts --target env --dry-run    # checks the file only, never connects
 *   node scripts/seed-templates.ts --target env              # a deployed database: needs the Owner's approval
 *
 * `--dry-run` verifies the file (shape and content hashes) and prints what would be sent. The run prints one line per
 * template and never prints connection strings or any secret.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDatabaseUrl } from '../src/env.ts';
import { applySeed, verifySeed } from '../src/seed-templates.ts';
import { connectionConfig, loadEnvironment, parseTarget } from './shared.ts';

const SEED_FILE = fileURLToPath(new URL('../../templates/seed/builtin-templates.json', import.meta.url));

const args = process.argv.slice(2);
const target = parseTarget(args);
const dryRun = args.includes('--dry-run');

const seed = verifySeed(JSON.parse(readFileSync(SEED_FILE, 'utf8')));

if (dryRun) {
  for (const t of seed.templates) {
    process.stdout.write(`would publish ${t.slug} (${t.category}) hash ${t.contentHash.slice(0, 12)}\n`);
  }
  process.stdout.write(`dry run: ${seed.templates.length} template(s) verified, nothing sent\n`);
} else {
  const env = loadEnvironment(target);
  const client = new pg.Client(connectionConfig(resolveDatabaseUrl('migrator', target, env), env));
  await client.connect();
  try {
    for (const o of await applySeed(client, seed)) {
      process.stdout.write(`${o.slug}: version ${o.version} ${o.created ? 'written' : 'unchanged'}\n`);
    }
  } finally {
    await client.end();
  }
}
