// P3 S0 finding: a TOTP factor enrolled under another BETTER_AUTH_SECRET (a Preview deployment sharing the live
// database) cannot be decrypted by Production ("invalid tag"), so its owner can never complete the 2FA challenge.
// This Owner-approved ops action removes that user's factor so they can sign in with their password and enrol again
// under the Production secret. One transaction: lock the user, delete the factor, clear the flag, write the audit
// event (`auth.mfa.disabled`, actor `system`, reason code only). Nothing secret is read, printed or logged.
//
//   node scripts/ops/reset-user-2fa.mjs --email someone@example.com            (dry run: shows what would change)
//   node scripts/ops/reset-user-2fa.mjs --email someone@example.com --apply    (writes)
//
// Connects as app_auth (DATABASE_URL_AUTH from .env.local), the role Better Auth itself uses for these tables.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pg = createRequire(path.join(root, 'packages/db/package.json'))('pg');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const email = args[args.indexOf('--email') + 1]?.trim().toLowerCase();
if (!args.includes('--email') || !email?.includes('@')) fail('pass --email <address>');

const local = {};
for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) local[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const url = local.DATABASE_URL_AUTH;
if (!url) fail('DATABASE_URL_AUTH is missing in .env.local');
if (decodeURIComponent(new URL(url).username).split('.')[0] !== 'app_auth')
  fail('DATABASE_URL_AUTH must use app_auth');
if (!local.DATABASE_SSL_ROOT_CERT) fail('DATABASE_SSL_ROOT_CERT is missing in .env.local');

const client = new pg.Client({
  connectionString: url,
  ssl: { ca: readFileSync(local.DATABASE_SSL_ROOT_CERT, 'utf8'), rejectUnauthorized: true },
});
const correlationId = randomUUID();

await client.connect();
try {
  await client.query('BEGIN');
  const user = await client.query(
    'SELECT id, two_factor_enabled FROM identity.users WHERE email = $1 FOR UPDATE',
    [email],
  );
  if (user.rowCount !== 1) fail('no user with that address');
  const { id, two_factor_enabled: enabled } = user.rows[0];
  const factors = await client.query(
    'SELECT count(*)::int AS n FROM identity.two_factors WHERE user_id = $1',
    [id],
  );
  console.log(`user ${id.slice(0, 8)}…  two_factor_enabled=${enabled}  factors=${factors.rows[0].n}`);
  if (!enabled && factors.rows[0].n === 0) {
    console.log('nothing to reset');
    await client.query('ROLLBACK');
  } else if (!apply) {
    console.log(
      'dry run: would delete the factor(s), set two_factor_enabled=false and audit auth.mfa.disabled',
    );
    await client.query('ROLLBACK');
  } else {
    const deleted = await client.query('DELETE FROM identity.two_factors WHERE user_id = $1', [id]);
    await client.query(
      'UPDATE identity.users SET two_factor_enabled = false, updated_at = now() WHERE id = $1',
      [id],
    );
    const audit = await client.query(
      `SELECT app.record_platform_audit('system'::app.audit_actor_type, NULL::uuid, 'auth.mfa.disabled', 'user', $1,
         'success'::app.audit_result, $2, $3::jsonb, NULL::inet, NULL) AS id`,
      [
        id,
        correlationId,
        JSON.stringify({
          reason: 'factor_unreadable_after_secret_change',
          approved_by: 'owner',
          slice: 'P3-S0',
        }),
      ],
    );
    await client.query('COMMIT');
    console.log(`applied: ${deleted.rowCount} factor(s) deleted, flag cleared, audit ${audit.rows[0].id}`);
    console.log(`correlation id ${correlationId}`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  fail(error.message);
} finally {
  await client.end();
}
