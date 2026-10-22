/**
 * Creates or reconciles the database roles of SRS 5.3 / ADR-003 / ADR-006. Idempotent: re-running it
 * re-applies attributes, memberships and settings, and rotates passwords to the values in the role URLs.
 *
 *   node scripts/bootstrap-roles.ts --target local   # Docker stack (default)
 *   node scripts/bootstrap-roles.ts --target env     # URLs from the environment / repository .env.local
 *
 * Runs as the operator role (Supabase `postgres`: CREATEROLE but not superuser). No role it creates is
 * SUPERUSER or BYPASSRLS. Passwords are sent as SCRAM verifiers, never in plaintext, and nothing secret
 * is printed.
 */
import pg from 'pg';
import {
  DEFINER_ROLE,
  EXPECTED_ROLES,
  isLocalHost,
  passwordOf,
  resolveDatabaseUrl,
  roleOf,
  type RuntimeRoleKey,
} from '../src/env.ts';
import { scramSha256Verifier } from '../src/scram.ts';
import { connectionConfig, loadEnvironment, parseTarget } from './shared.ts';

const MIN_PASSWORD_LENGTH = 32;
const RUNTIME_KEYS: RuntimeRoleKey[] = ['migrator', 'app', 'auth', 'public', 'admin'];
/** Guard rails for request-serving roles: a stuck statement or transaction cannot pin a pooled connection. */
const REQUEST_ROLE_SETTINGS: Record<string, string> = {
  statement_timeout: '15s',
  lock_timeout: '5s',
  idle_in_transaction_session_timeout: '30s',
};

const target = parseTarget(process.argv.slice(2));
const env = loadEnvironment(target);
const bootstrapUrl = resolveDatabaseUrl('bootstrap', target, env);
const urls = Object.fromEntries(RUNTIME_KEYS.map((k) => [k, resolveDatabaseUrl(k, target, env)])) as Record<
  RuntimeRoleKey,
  string
>;

for (const key of RUNTIME_KEYS) {
  const role = roleOf(urls[key]);
  if (role !== EXPECTED_ROLES[key]) {
    throw new Error(`connection string for ${key} authenticates as ${role}, expected ${EXPECTED_ROLES[key]}`);
  }
}

const admin = new pg.Client(connectionConfig(bootstrapUrl, env));
await admin.connect();
const q = (sql: string) => admin.query(sql);

try {
  const { rows: who } = await admin.query<{ usr: string; db: string; su: boolean }>(
    `SELECT current_user AS usr, current_database() AS db, r.rolsuper AS su
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const database = who[0]?.db;
  if (!database) throw new Error('could not determine the current database');
  if (who[0]?.su) console.warn('warning: bootstrapping as a superuser; Supabase does not provide one');

  await q('BEGIN');
  for (const key of RUNTIME_KEYS) {
    const role = EXPECTED_ROLES[key];
    await ensureRole(role, true);
    const password = passwordOf(urls[key]);
    if (password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password for ${role} is shorter than ${MIN_PASSWORD_LENGTH} characters`);
      }
      await q(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(scramSha256Verifier(password))}`);
    } else if (!isLocalHost(urls[key])) {
      throw new Error(`connection string for ${role} has no password`);
    }
    if (key !== 'migrator') {
      for (const [name, value] of Object.entries(REQUEST_ROLE_SETTINGS)) {
        await q(`ALTER ROLE ${role} SET ${name} = ${admin.escapeLiteral(value)}`);
      }
    }
    await q(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${role}`);
  }
  await ensureRole(DEFINER_ROLE, false);
  // INHERIT FALSE is mandatory: with INHERIT the migrator would inherit the definer policies and could read
  // every tenant's rows (Spike B B-7). SET TRUE lets migrations hand function ownership to svc_definer.
  await q(`GRANT ${DEFINER_ROLE} TO migrator WITH INHERIT FALSE, SET TRUE`);
  // Migrations create the `identity` and `app` schemas.
  await q(`GRANT CREATE ON DATABASE ${quoteIdent(database)} TO migrator`);

  if (target === 'local') {
    // Shadow database for `prisma migrate diff` (drift check); local stack only.
    await q('GRANT CONNECT, CREATE ON DATABASE platform_shadow TO migrator');
  }
  await q('COMMIT');

  await verifyRoles();
} catch (error) {
  await q('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await admin.end();
}

await verifyLogins();
process.stdout
  .write(`bootstrap complete (${target}): roles reconciled and every role URL authenticates as its role
`);

async function ensureRole(role: string, login: boolean): Promise<void> {
  const common = `${login ? 'LOGIN' : 'NOLOGIN'} NOCREATEDB NOCREATEROLE NOBYPASSRLS`;
  const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  // Only a superuser may even restate SUPERUSER/REPLICATION in ALTER ROLE, so those two are fixed at creation
  // and checked afterwards by verifyRoles().
  await q(
    rowCount
      ? `ALTER ROLE ${role} WITH ${common}`
      : `CREATE ROLE ${role} WITH ${common} NOSUPERUSER NOREPLICATION`,
  );
}

async function verifyRoles(): Promise<void> {
  const roles = [...Object.values(EXPECTED_ROLES), DEFINER_ROLE];
  const { rows } = await admin.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
  }>(
    'SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = ANY($1)',
    [roles],
  );
  if (rows.length !== roles.length) throw new Error('not every platform role exists after bootstrap');
  for (const r of rows) {
    if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolreplication) {
      throw new Error(`${r.rolname} must not be SUPERUSER, BYPASSRLS, CREATEROLE or REPLICATION`);
    }
  }
  const { rows: members } = await admin.query<{
    member: string;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT m.rolname AS member, a.inherit_option, a.set_option
       FROM pg_auth_members a
       JOIN pg_roles g ON g.oid = a.roleid
       JOIN pg_roles m ON m.oid = a.member
      WHERE g.rolname = $1`,
    [DEFINER_ROLE],
  );
  const migrator = members.find((m) => m.member === 'migrator');
  if (!migrator || migrator.inherit_option || !migrator.set_option) {
    throw new Error('migrator must be a member of svc_definer WITH INHERIT FALSE, SET TRUE');
  }
  const others = members.filter(
    (m) => m.member !== 'migrator' && Object.values(EXPECTED_ROLES).includes(m.member),
  );
  if (others.length)
    throw new Error(`unexpected svc_definer members: ${others.map((m) => m.member).join(', ')}`);
}

async function verifyLogins(): Promise<void> {
  for (const key of RUNTIME_KEYS) {
    const client = new pg.Client(connectionConfig(urls[key], env));
    await client.connect();
    try {
      const { rows } = await client.query<{ usr: string }>('SELECT current_user AS usr');
      if (rows[0]?.usr !== EXPECTED_ROLES[key]) {
        throw new Error(`${key} URL authenticated as ${rows[0]?.usr ?? 'nobody'}`);
      }
    } finally {
      await client.end();
    }
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
