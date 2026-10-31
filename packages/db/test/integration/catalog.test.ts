/**
 * Static database guarantees, read from the catalog (SRS 5.3 items 1-2, SEC-01, Spike B B-6/B-7/B-8).
 * These fail as soon as a migration adds a table, grant, policy or function that breaks the pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTenantDatabase } from '../../src/client';
import { UnsafeRoleError } from '../../src/errors';
import { expectPgError, pool, tenantTables, urls } from './helpers';

const PLATFORM_ROLES = ['migrator', 'app_user', 'app_auth', 'app_public', 'app_admin', 'svc_definer'];
/** The only roles that may hold any privilege on a product object. */
const PRIVILEGED_GRANTEES = new Set(['migrator', 'app_user', 'app_auth', 'svc_definer', 'app_admin']);

let admin: pg.Pool;
let publicRole: pg.Pool;

beforeAll(() => {
  admin = pool(urls.bootstrap);
  publicRole = pool(urls.public);
});
afterAll(async () => {
  await Promise.all([admin.end(), publicRole.end()]);
});

describe('roles', () => {
  it('no platform role is SUPERUSER, BYPASSRLS, CREATEROLE or REPLICATION', async () => {
    const { rows } = await admin.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [PLATFORM_ROLES],
    );
    expect(rows).toHaveLength(PLATFORM_ROLES.length);
    for (const r of rows) {
      expect([r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolreplication]).toEqual([
        r.rolname,
        false,
        false,
        false,
        false,
      ]);
    }
    expect(rows.find((r) => r.rolname === 'svc_definer')?.rolcanlogin).toBe(false);
  });

  it('migrator is a member of svc_definer WITH INHERIT FALSE, SET TRUE and no request role is a member of anything', async () => {
    const { rows } = await admin.query(
      `SELECT g.rolname AS grp, m.rolname AS member, a.inherit_option, a.set_option, a.admin_option
         FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE m.rolname = ANY($1)`,
      [PLATFORM_ROLES],
    );
    expect(rows).toEqual([
      {
        grp: 'svc_definer',
        member: 'migrator',
        inherit_option: false,
        set_option: true,
        admin_option: false,
      },
    ]);
  });

  it('request roles carry statement, lock and idle-in-transaction timeouts', async () => {
    const { rows } = await admin.query(
      `SELECT r.rolname, s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
        WHERE r.rolname = ANY($1)`,
      [['app_user', 'app_auth', 'app_public', 'app_admin']],
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.setconfig).toEqual(
        expect.arrayContaining([
          'statement_timeout=15s',
          'lock_timeout=5s',
          'idle_in_transaction_session_timeout=30s',
        ]),
      );
    }
  });
});

describe('row-level security coverage', () => {
  it('every app table has RLS enabled AND forced (the Prisma migration ledger is the only exception)', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    const unprotected = rows.filter(
      (r) => r.relname !== '_prisma_migrations' && !(r.relrowsecurity && r.relforcerowsecurity),
    );
    expect(unprotected).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it('every tenant table (auto-discovered by workspace_id) has app_user policies that reference the context', async () => {
    const tables = await tenantTables(admin);
    expect(tables).toEqual([
      'audit_logs',
      'client_contacts',
      'domains',
      'invitations',
      'job_dead_letters',
      'memberships',
      'notification_preferences',
      'notifications',
      'outbox_events',
      'projects',
    ]);
    for (const table of [...tables, 'workspaces']) {
      const { rows } = await admin.query(
        `SELECT policyname, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies
          WHERE schemaname = 'app' AND tablename = $1`,
        [table],
      );
      const userPolicies = rows.filter((p) => p.roles.includes('app_user'));
      expect(userPolicies.length, table).toBeGreaterThan(0);
      for (const p of userPolicies) {
        expect(`${p.qual ?? ''} ${p.with_check ?? ''}`, `${table}.${p.policyname}`).toMatch(
          /current_workspace\(\)|current_actor_user\(\)/,
        );
      }
    }
  });

  it('policies only ever name app_user or svc_definer', async () => {
    const { rows } = await admin.query(
      `SELECT tablename, policyname, roles::text[] AS roles FROM pg_policies WHERE schemaname IN ('app', 'identity')`,
    );
    for (const p of rows) {
      for (const role of p.roles as string[])
        expect(['app_user', 'svc_definer'], `${p.tablename}.${p.policyname}`).toContain(role);
    }
  });

  it('context functions use the mandatory NULLIF form (Spike B B-1)', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname IN ('current_workspace', 'current_actor_user')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows)
      expect(r.def).toMatch(
        /NULLIF\(pg_catalog\.current_setting\('app\.(workspace|user)_id', true\), ''\)::uuid/,
      );
  });
});

describe('privileges', () => {
  it('no product table, column or sequence privilege is held by a role outside the allow-list', async () => {
    // Raw ACLs (relation and column level); information_schema would hide grants the inspecting role cannot see.
    const { rows } = await admin.query(
      `SELECT n.nspname, c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) x
        WHERE n.nspname IN ('app', 'identity')
       UNION
       SELECT n.nspname, c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
              aclexplode(a.attacl) x
        WHERE n.nspname IN ('app', 'identity')`,
    );
    expect(rows.length).toBeGreaterThan(20);
    const foreign = rows.filter((r) => !PRIVILEGED_GRANTEES.has(r.grantee));
    expect(foreign).toEqual([]);
  });

  it('identity is reachable only by app_auth (and the definer for the MFA check)', async () => {
    const { rows } = await admin.query(
      `SELECT r.rolname, has_schema_privilege(r.rolname, 'identity', 'USAGE') AS usage
         FROM pg_roles r WHERE r.rolname = ANY($1) ORDER BY 1`,
      [[...PLATFORM_ROLES, 'anon', 'authenticated', 'service_role']],
    );
    const withUsage = rows.filter((r) => r.usage).map((r) => r.rolname);
    expect(withUsage.sort()).toEqual(['app_auth', 'migrator', 'svc_definer']);
  });

  it('app_auth has no privilege on tenant tables; app_user none on identity tables', async () => {
    const { rows } = await admin.query(
      `SELECT n.nspname, c.relname,
              has_table_privilege('app_auth', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS auth_any,
              has_table_privilege('app_user', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS user_any,
              has_table_privilege('app_public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_any,
              has_table_privilege('app_admin', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS admin_any
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('app', 'identity') AND c.relkind = 'r'`,
    );
    for (const r of rows) {
      if (r.nspname === 'identity') expect([r.relname, r.user_any]).toEqual([r.relname, false]);
      else expect([r.relname, r.auth_any]).toEqual([r.relname, false]);
      expect([r.relname, r.public_any, r.admin_any]).toEqual([r.relname, false, false]);
    }
  });

  it('server-controlled columns and the audit trail are not writable by app_user', async () => {
    const checks: Array<[string, string, string]> = [
      ['app.workspaces', 'status', 'UPDATE'],
      ['app.workspaces', 'suspended_at', 'UPDATE'],
      ['app.workspaces', 'plan_id', 'UPDATE'],
      ['app.workspaces', 'id', 'UPDATE'],
      ['app.projects', 'workspace_id', 'UPDATE'],
      ['app.memberships', 'workspace_id', 'UPDATE'],
      ['app.memberships', 'user_id', 'UPDATE'],
      ['app.domains', 'hostname', 'UPDATE'],
      ['app.domains', 'status', 'UPDATE'],
      ['app.invitations', 'accepted_at', 'UPDATE'],
      ['app.notifications', 'user_id', 'UPDATE'],
    ];
    for (const [table, column, privilege] of checks) {
      const { rows } = await admin.query(
        `SELECT has_column_privilege('app_user', c.oid, $2, $3) AS ok FROM pg_class c
          WHERE c.oid = (SELECT oid FROM pg_class WHERE relname = split_part($1, '.', 2)
                          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = split_part($1, '.', 1)))`,
        [table, column, privilege],
      );
      expect([table, column, privilege, rows[0].ok]).toEqual([table, column, privilege, false]);
    }
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const { rows } = await admin.query(
        `SELECT has_table_privilege('app_user', c.oid, $1) AS ok FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = 'audit_logs'`,
        [privilege],
      );
      expect([privilege, rows[0].ok]).toEqual([privilege, false]);
    }
  });

  it('the Prisma migration ledger is private to migrator', async () => {
    const { rows } = await admin.query(
      `SELECT r.rolname FROM pg_roles r, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = '_prisma_migrations'
          AND has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE') AND r.rolname = ANY($1)`,
      [PLATFORM_ROLES.filter((r) => r !== 'migrator')],
    );
    expect(rows).toEqual([]);
  });

  it('nothing product-related lives in the public schema', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = ANY($1)
       UNION ALL
       SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = ANY($1)`,
      [PLATFORM_ROLES],
    );
    expect(rows).toEqual([]);
  });

  it('app_public cannot read or write any table', async () => {
    const tables = [...(await tenantTables(admin)), 'workspaces', 'platform_admins'];
    for (const table of tables)
      await expectPgError(publicRole.query(`SELECT 1 FROM app.${table} LIMIT 1`), '42501');
    await expectPgError(publicRole.query('SELECT 1 FROM identity.users LIMIT 1'), '42501');
  });
});

describe('functions', () => {
  it('every SECURITY DEFINER function is owned by svc_definer and pins search_path', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', 'identity') AND p.prosecdef`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([
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
    ]);
    for (const r of rows) {
      expect([r.proname, r.owner]).toEqual([r.proname, 'svc_definer']);
      expect(r.proconfig, r.proname).toContain('search_path=""');
    }
  });

  it('no product function is executable by PUBLIC, and each definer function only by its intended role', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'`,
    );
    for (const r of rows) {
      expect(r.acl ?? '', r.proname).not.toMatch(/(^|[{,])=X/);
    }
    const executors = async (fn: string) => {
      const { rows: e } = await admin.query(
        `SELECT r.rolname FROM pg_roles r, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = $1 AND r.rolname = ANY($2)
            AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
        [fn, ['app_user', 'app_auth', 'app_public', 'app_admin', 'migrator']],
      );
      return e.map((x) => x.rolname).sort();
    };
    // S8: the admin console functions are app_admin's only functions; their helpers are nobody's.
    for (const fn of [
      'admin_console_state',
      'admin_step_up_begin',
      'admin_step_up_finish',
      'admin_list_workspaces',
      'admin_get_workspace',
      'admin_list_users',
      'admin_list_audit',
      'admin_set_workspace_status',
    ]) {
      expect(await executors(fn), fn).toEqual(['app_admin']);
    }
    for (const fn of [
      'admin_session_valid',
      'admin_step_up_until',
      'admin_step_up_locked_until',
      'admin_require',
      'admin_audit',
      'mask_email',
      'admin_query_kind',
    ]) {
      expect(await executors(fn), fn).toEqual([]);
    }
    const { rows: adminFns } = await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', 'identity') AND has_function_privilege('app_admin', p.oid, 'EXECUTE')`,
    );
    expect(adminFns.every((r) => String(r.proname).startsWith('admin_'))).toBe(true);
    expect(adminFns).toHaveLength(8);
    expect(await executors('record_platform_audit')).toEqual(['app_auth']);
    expect(await executors('operator_grant_platform_admin')).toEqual(['migrator']);
    expect(await executors('operator_revoke_platform_admin')).toEqual(['migrator']);
    expect(await executors('operator_set_platform_setting')).toEqual(['migrator']);
    // S7: the visitor role's only function (SRS 5.3 item 1); no other role needs it.
    expect(await executors('resolve_host')).toEqual(['app_public']);
    const { rows: publicFns } = await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', 'identity') AND has_function_privilege('app_public', p.oid, 'EXECUTE')`,
    );
    expect(publicFns.map((r) => r.proname)).toEqual(['resolve_host']);
    expect(await executors('workspace_writable')).toEqual(['app_user']);
    // S5: membership role helpers, invitation acceptance/preview, the member directory and the slug list.
    for (const fn of [
      'current_member_role',
      'workspace_has_members',
      'accept_invitation',
      'invitation_preview',
      'workspace_members',
      // S6: the subdomain allocator, the e-mail job's reader and the outbox sweep's reader.
      'allocate_platform_subdomain',
      'notification_delivery',
      'outbox_pending',
    ]) {
      expect(await executors(fn), fn).toEqual(['app_user']);
    }
    // Invoker functions owned by migrator (the owner always holds EXECUTE): the slug list for app_user's CHECK,
    // and the trigger functions, which no request role can call directly.
    for (const fn of ['is_reserved_slug', 'reserved_slugs', 'project_transition_roles']) {
      expect(await executors(fn), fn).toEqual(['app_user', 'migrator']);
    }
    for (const fn of ['memberships_guard', 'workspaces_guard', 'projects_guard']) {
      expect(await executors(fn), fn).toEqual(['migrator']);
    }
    expect(await executors('memberships_keep_owner')).toEqual([]);
  });

  it('audit_logs carries the append-only triggers', async () => {
    const { rows } = await admin.query(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = 'audit_logs' AND NOT t.tgisinternal ORDER BY 1`,
    );
    expect(rows.map((r) => r.tgname)).toEqual(['audit_logs_append_only', 'audit_logs_no_truncate']);
  });
});

describe('runtime role guard', () => {
  it('accepts app_user and rejects a BYPASSRLS operator or the wrong role', async () => {
    const good = createTenantDatabase({ connectionString: urls.app, poolMax: 1 });
    const operator = createTenantDatabase({ connectionString: urls.bootstrap, poolMax: 1 });
    try {
      await expect(good.verifyRole()).resolves.toBeUndefined();
      await expect(operator.verifyRole('platform_admin')).rejects.toThrow(/BYPASSRLS/);
      await expect(operator.verifyRole()).rejects.toBeInstanceOf(UnsafeRoleError);
    } finally {
      await Promise.all([good.disconnect(), operator.disconnect()]);
    }
  });
});
