/**
 * Mints a preview / pitch link for a built-in template (FR-TPL-09, P2 S6) from the command line, until the dashboard
 * has its own "share a preview" page. The template is looked up in the catalogue as `app_public` (read-only), and the
 * link is signed with `PREVIEW_TOKEN_SECRET`, the same secret the sites app verifies with.
 *
 *   PREVIEW_HOST=preview.sites.localhost PREVIEW_TOKEN_SECRET=... \
 *     node scripts/preview-link.ts --target local --template gym-bold --name "Sharma Gym" --days 7
 *
 * Options: --template <slug> (required), --name <prospect business name>, --days <1..30, default 7>,
 * --version <n> (pin a template version). Prints the URL only; the secret is never printed. Anyone holding the link can
 * open the preview until it expires (it shows demo content only); rotating the secret revokes every link.
 */
import pg from 'pg';
import { resolveDatabaseUrl } from '../src/env.ts';
import { mintPreviewToken } from '../../hosting/src/preview-token.ts';
import { connectionConfig, loadEnvironment, parseTarget } from './shared.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const target = parseTarget(args);
const slug = flag('template');
if (!slug) throw new Error('--template <slug> is required (for example gym-bold)');
const days = Number(flag('days') ?? '7');
if (!Number.isInteger(days) || days < 1 || days > 30)
  throw new Error('--days must be an integer from 1 to 30');
const versionFlag = flag('version');
const version = versionFlag === undefined ? undefined : Number(versionFlag);

const env = loadEnvironment(target);
const secret = env.PREVIEW_TOKEN_SECRET;
const host = env.PREVIEW_HOST;
if (!secret || !host) throw new Error('PREVIEW_TOKEN_SECRET and PREVIEW_HOST must be set');
const local = host.endsWith('localhost');

const client = new pg.Client(connectionConfig(resolveDatabaseUrl('public', target, env), env));
await client.connect();
try {
  const { rows } = await client.query<{ template_id: string; name: string }>(
    'SELECT template_id, name FROM app.list_catalog_templates() WHERE slug = $1',
    [slug],
  );
  const found = rows[0];
  if (!found) throw new Error(`No published template "${slug}" in the catalogue`);
  const token = mintPreviewToken(secret, {
    templateId: found.template_id,
    ...(version !== undefined ? { version } : {}),
    ...(flag('name') ? { prospectName: flag('name') as string } : {}),
    lifetimeSeconds: days * 86_400,
  });
  const origin = `${local ? 'http' : 'https'}://${host}${local ? ':3001' : ''}`;
  process.stdout.write(`${found.name}, valid ${days} day(s):\n${origin}/p/${token}\n`);
} finally {
  await client.end();
}
