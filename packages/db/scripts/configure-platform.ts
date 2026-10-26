/**
 * Sets the platform settings of one environment (P1 S6), today only `sites_domain`: the parent domain of every
 * platform subdomain (FR-DOM-01, Q9). Runs as `migrator` through `app.operator_set_platform_setting`, which
 * validates the value and writes a platform audit row. Idempotent.
 *
 *   node scripts/configure-platform.ts --target local                       # sites.localhost
 *   SITES_DOMAIN=example-sites.com node scripts/configure-platform.ts --target env
 *
 * `--target env` requires SITES_DOMAIN: a deployed environment never gets the local default by accident.
 */
import pg from 'pg';
import { resolveDatabaseUrl } from '../src/env.ts';
import { connectionConfig, loadEnvironment, parseTarget } from './shared.ts';

export const LOCAL_SITES_DOMAIN = 'sites.localhost';

const target = parseTarget(process.argv.slice(2));
const env = loadEnvironment(target);
const sitesDomain = env.SITES_DOMAIN ?? (target === 'local' ? LOCAL_SITES_DOMAIN : undefined);
if (!sitesDomain) throw new Error('SITES_DOMAIN is required for --target env');

const client = new pg.Client(connectionConfig(resolveDatabaseUrl('migrator', target, env), env));
await client.connect();
try {
  // migrator cannot read the table itself (FORCE RLS, no policy for it); the function reports the change.
  const { rows } = await client.query<{ changed: boolean }>(
    `SELECT app.operator_set_platform_setting('sites_domain', $1) AS changed`,
    [sitesDomain],
  );
  const outcome = rows[0]?.changed ? 'set to' : 'already';
  process.stdout.write(`sites_domain ${outcome} ${sitesDomain}\n`);
} finally {
  await client.end();
}
