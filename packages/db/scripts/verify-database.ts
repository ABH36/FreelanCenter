/**
 * Read-only verification of a deployed database (SRS 5.3, SEC-01). Writes nothing, so it is safe against a
 * live project:
 *
 *   node scripts/verify-database.ts --target env     # URLs from the environment / repository .env.local
 *   node scripts/verify-database.ts --target local   # Docker stack
 *
 * Catalog checks run as the operator role; runtime checks use each role's own URL. Exit code 1 on any failure.
 */
import pg from 'pg';
import { DEFINER_ROLE, EXPECTED_ROLES, resolveDatabaseUrl, type RuntimeRoleKey } from '../src/env.ts';
import { connectionConfig, loadEnvironment, parseTarget } from './shared.ts';

const target = parseTarget(process.argv.slice(2));
const env = loadEnvironment(target);
const ROLES = [...Object.values(EXPECTED_ROLES), DEFINER_ROLE];
const ALLOWED_GRANTEES = new Set(['migrator', 'app_user', 'app_auth', 'svc_definer', 'app_admin']);
const failures: string[] = [];
let passed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failures.push(detail ? `${name}: ${detail}` : name);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}\n`);
}

async function withClient<T>(
  key: RuntimeRoleKey | 'bootstrap',
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(connectionConfig(resolveDatabaseUrl(key, target, env), env));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function denied(client: pg.Client, sql: string): Promise<boolean> {
  try {
    await client.query(sql);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === '42501';
  }
}

const tenantTables = await withClient('bootstrap', async (op) => {
  const { rows: roles } = await op.query(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolreplication)`,
    [ROLES],
  );
  const { rows: count } = await op.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)', [
    ROLES,
  ]);
  check('all six platform roles exist', count[0].n === ROLES.length, `${count[0].n} found`);
  check(
    'no platform role is SUPERUSER/BYPASSRLS/CREATEROLE/REPLICATION',
    roles.length === 0,
    roles.map((r) => r.rolname).join(', '),
  );

  const { rows: members } = await op.query(
    `SELECT g.rolname AS grp, m.rolname AS member, a.inherit_option, a.set_option
       FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = ANY($1)`,
    [ROLES],
  );
  check(
    'only membership: migrator in svc_definer WITH INHERIT FALSE, SET TRUE',
    members.length === 1 &&
      members[0].grp === DEFINER_ROLE &&
      members[0].member === 'migrator' &&
      !members[0].inherit_option &&
      members[0].set_option,
    JSON.stringify(members),
  );

  const { rows: migrations } = await op.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = '_prisma_migrations'`,
  );
  check('migration ledger present in schema app', migrations[0].n === 1);

  const { rows: rls } = await op.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
  );
  check('every app table has RLS enabled and forced', rls.length === 0, rls.map((r) => r.relname).join(', '));

  const { rows: grants } = await op.query(
    `SELECT DISTINCT c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) x
      WHERE n.nspname IN ('app', 'identity')
     UNION
     SELECT DISTINCT c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(a.attacl) x
      WHERE n.nspname IN ('app', 'identity')`,
  );
  const foreign = grants.filter((g) => !ALLOWED_GRANTEES.has(g.grantee));
  check(
    'no table/column privilege for PUBLIC, anon, authenticated, service_role or app_public',
    foreign.length === 0 && grants.length > 20,
    JSON.stringify(foreign),
  );

  const { rows: usage } = await op.query(
    `SELECT n.nspname, r.rolname FROM pg_namespace n, pg_roles r
      WHERE n.nspname IN ('app', 'identity') AND r.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
        AND has_schema_privilege(r.rolname, n.oid, 'USAGE')`,
  );
  check('Supabase API roles have no USAGE on app/identity', usage.length === 0, JSON.stringify(usage));

  const { rows: definers } = await op.query(
    `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig, p.proacl::text AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.prosecdef`,
  );
  // P1 foundation (5) + P1 S5 (6) + P1 S6 (4) + P1 S7 (1) + P1 S8 (7). An unexpected definer is as much a
  // finding as a missing one.
  const expectedDefiners = [
    'accept_invitation',
    'admin_console_state',
    'admin_get_workspace',
    'admin_list_audit',
    'admin_list_users',
    'admin_list_workspaces',
    'admin_set_workspace_status',
    'admin_step_up_begin',
    'admin_step_up_finish',
    'allocate_platform_subdomain',
    'current_member_role',
    'invitation_preview',
    'memberships_keep_owner',
    'notification_delivery',
    'operator_grant_platform_admin',
    'operator_revoke_platform_admin',
    'operator_set_platform_setting',
    'outbox_pending',
    'record_platform_audit',
    'resolve_host',
    'workspace_has_members',
    'workspace_members',
    'workspace_writable',
  ];
  check(
    `SECURITY DEFINER functions: exactly the ${expectedDefiners.length} expected, owned by svc_definer, search_path pinned`,
    JSON.stringify(definers.map((d) => d.proname).sort()) === JSON.stringify(expectedDefiners) &&
      definers.every((d) => d.owner === DEFINER_ROLE && (d.proconfig ?? []).includes('search_path=""')),
    JSON.stringify(definers.map((d) => [d.proname, d.owner])),
  );
  const { rows: publicExec } = await op.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND (p.proacl IS NULL OR p.proacl::text ~ '(^|[{,])=X')`,
  );
  check(
    'no app function executable by PUBLIC',
    publicExec.length === 0,
    publicExec.map((r) => r.proname).join(', '),
  );

  // S7: the visitor role executes exactly one function, the host resolver (SRS 5.3 item 1).
  const { rows: publicFns } = await op.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('app', 'identity') AND has_function_privilege('app_public', p.oid, 'EXECUTE')`,
  );
  check(
    'app_public can execute exactly app.resolve_host',
    JSON.stringify(publicFns.map((r) => r.proname)) === JSON.stringify(['resolve_host']),
    publicFns.map((r) => r.proname).join(', '),
  );

  // S8: the admin role executes exactly the console functions; the console's internal checks are executable by
  // no application role (they run only inside those functions, as their owner).
  const { rows: adminFns } = await op.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('app', 'identity') AND has_function_privilege('app_admin', p.oid, 'EXECUTE')
      ORDER BY 1`,
  );
  const expectedAdminFns = expectedDefiners.filter((f) => f.startsWith('admin_'));
  check(
    `app_admin can execute exactly the ${expectedAdminFns.length} admin console functions`,
    JSON.stringify(adminFns.map((r) => r.proname)) === JSON.stringify(expectedAdminFns),
    adminFns.map((r) => r.proname).join(', '),
  );
  const { rows: helperExec } = await op.query(
    `SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
            pg_roles r
      WHERE n.nspname = 'app'
        AND p.proname IN ('admin_session_valid', 'admin_step_up_until', 'admin_step_up_locked_until',
                          'admin_require', 'admin_audit', 'mask_email', 'admin_query_kind')
        AND r.rolname IN ('app_user', 'app_auth', 'app_public', 'app_admin', 'migrator')
        AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
  );
  check(
    'admin console helpers are executable by no application role',
    helperExec.length === 0,
    JSON.stringify(helperExec),
  );

  const { rows: inPublic } = await op.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = ANY($1)`,
    [ROLES],
  );
  check(
    'no product object in schema public',
    inPublic.length === 0,
    inPublic.map((r) => r.relname).join(', '),
  );

  const { rows: tables } = await op.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
      WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`,
  );
  return [...tables.map((t) => t.relname), 'workspaces'];
});

await withClient('app', async (c) => {
  const { rows } = await c.query('SELECT current_user AS u');
  check('DATABASE_URL authenticates as app_user', rows[0].u === 'app_user', rows[0].u);
  let nonZero = 0;
  for (let i = 0; i < 10; i++) {
    for (const table of tenantTables) {
      const { rows: n } = await c.query(`SELECT count(*)::int AS n FROM app.${table}`);
      if (n[0].n !== 0) nonZero++;
    }
  }
  check(
    `app_user without context sees 0 rows in ${tenantTables.length} tables (x10, pooled)`,
    nonZero === 0,
    `${nonZero} non-zero`,
  );
  check('app_user is denied the identity schema', await denied(c, 'SELECT 1 FROM identity.users LIMIT 1'));
  check('app_user cannot update audit_logs', await denied(c, "UPDATE app.audit_logs SET action = 'x.y'"));
});

// S6: platform subdomains need this environment's sites domain (db:configure). No application role can read
// platform_settings, so read it as svc_definer (migrator holds SET on it) in a READ ONLY transaction.
await withClient('migrator', async (c) => {
  await c.query('BEGIN READ ONLY');
  try {
    await c.query('SET LOCAL ROLE svc_definer');
    const { rows } = await c.query("SELECT value FROM app.platform_settings WHERE key = 'sites_domain'");
    check(
      'sites_domain is configured (platform subdomains, Q9)',
      rows.length === 1,
      'missing: run db:configure',
    );
  } finally {
    await c.query('ROLLBACK');
  }
});

await withClient('auth', async (c) => {
  await c.query('SELECT count(*) FROM identity.users');
  check('app_auth reads identity', true);
  check('app_auth is denied tenant tables', await denied(c, 'SELECT 1 FROM app.projects LIMIT 1'));
});

await withClient('public', async (c) => {
  const results: boolean[] = [];
  for (const t of tenantTables) results.push(await denied(c, `SELECT 1 FROM app.${t} LIMIT 1`));
  check('app_public is denied every tenant table', results.every(Boolean));
  check('app_public is denied identity', await denied(c, 'SELECT 1 FROM identity.users LIMIT 1'));
  // Read-only: a host name that cannot exist (RFC 2606 `.invalid`) resolves to `unknown`.
  const { rows } = await c.query("SELECT outcome FROM app.resolve_host('db-verify.invalid')");
  check(
    'app_public resolves an unknown host to unknown (resolve_host)',
    rows.length === 1 && rows[0].outcome === 'unknown',
    JSON.stringify(rows),
  );
  check(
    'app_public cannot allocate subdomains',
    await denied(
      c,
      "SELECT app.allocate_platform_subdomain('00000000-0000-7000-8000-000000000000', 'x-verify')",
    ),
  );
});

await withClient('admin', async (c) => {
  check('app_admin is denied direct table access', await denied(c, 'SELECT 1 FROM app.workspaces LIMIT 1'));
  check('app_admin is denied the step-up table', await denied(c, 'SELECT 1 FROM app.admin_step_ups LIMIT 1'));
  // Read-only: ids that cannot be an admin's session are refused before anything is written.
  check(
    'the admin console refuses a caller without a stepped-up admin session',
    await denied(
      c,
      "SELECT * FROM app.admin_list_workspaces('00000000-0000-7000-8000-000000000000', '00000000-0000-7000-8000-000000000000', NULL, NULL, NULL, 1, NULL)",
    ),
  );
  check(
    'app_admin cannot grant platform admins',
    await denied(c, "SELECT app.operator_grant_platform_admin('00000000-0000-7000-8000-000000000000', 'x')"),
  );
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed (${target})\n`);
if (failures.length) process.exit(1);
