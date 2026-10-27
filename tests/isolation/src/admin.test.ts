/**
 * The admin role (SEC-17, FR-ADM-01/02; P1 S8). The admin console reaches every workspace by design, so the IDOR
 * property of `./idor` does not apply to it; what must hold instead is that nobody but a stepped-up platform admin
 * reaches it at all:
 *   - app_admin holds no privilege on any product relation and executes only the admin console functions;
 *   - no tenant, auth or visitor role executes any admin function;
 *   - the owner of a workspace (the strongest tenant role), with MFA and a live session, is refused by every
 *     console function and cannot start a step-up, and the victim workspace is unchanged;
 *   - a granted admin without a step-up of this session is refused by every console function.
 * The dashboard actions (`adminStepUpAction`, `setWorkspaceStatusAction`) wrap exactly these functions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { type AdminDatabase, type AdminPrincipal, createAdminDatabase } from '@platform/db/admin';
import { createSessionRow, steppedUpAdmin } from '@platform/db/testing';
import { productRelations } from './catalog';
import { createWorld, expectPgError, pool, urls, type World } from './fixtures';

let w: World;
let migrator: pg.Pool;
let adminRole: pg.Pool;
let console_: AdminDatabase;

beforeAll(async () => {
  w = await createWorld();
  migrator = pool(urls.migrator, 1);
  adminRole = pool(urls.admin, 2);
  console_ = createAdminDatabase({ connectionString: urls.admin });
});
afterAll(async () => {
  await console_.close();
  await Promise.all([migrator.end(), adminRole.end()]);
  await w.close();
});

/** Every console function, called with the given principal against the victim workspace B. */
const consoleCalls = (p: AdminPrincipal): Array<[string, () => Promise<unknown>]> => [
  [
    'admin_list_workspaces',
    () => console_.listWorkspaces(p, { query: null, status: null, before: null, limit: 5 }, null),
  ],
  ['admin_get_workspace', () => console_.getWorkspace(p, w.B.scope.workspaceId, null)],
  ['admin_list_users', () => console_.listUsers(p, { query: null, before: null, limit: 5 }, null)],
  ['admin_list_audit', () => console_.listAudit(p, { action: null, actorId: null, before: null, limit: 5 })],
  [
    'admin_set_workspace_status',
    () =>
      console_.setWorkspaceStatus(
        p,
        { workspaceId: w.B.scope.workspaceId, status: 'suspended', reason: 'isolation probe' },
        null,
      ),
  ],
];

const victimStatus = async () =>
  w.db.withTenant(w.B.scope, (tx) =>
    tx.workspace.findUniqueOrThrow({ where: { id: w.B.scope.workspaceId }, select: { status: true } }),
  );

describe('admin role app_admin (SEC-17)', () => {
  it('app_admin can read or write no product relation, by privilege', async () => {
    const relations = await productRelations(w.admin);
    const { rows } = await w.admin.query<{ rel: string }>(
      `SELECT n.nspname || '.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1)
          AND (has_table_privilege('app_admin', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR has_any_column_privilege('app_admin', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`,
      [relations.map((r) => r.qualified)],
    );
    expect(rows.map((r) => r.rel)).toEqual([]);
  });

  it('app_user, app_auth and app_public execute no admin console function', async () => {
    const { rows } = await w.admin.query<{ fn: string; role: string }>(
      `SELECT p.proname AS fn, r.rolname AS role FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
              pg_roles r
        WHERE n.nspname = 'app' AND (p.proname LIKE 'admin\\_%' OR p.proname = 'mask_email')
          AND r.rolname IN ('app_user', 'app_auth', 'app_public')
          AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
    for (const url of [urls.app, urls.auth, urls.public]) {
      const p = pool(url, 1);
      try {
        await expectPgError(
          p.query('SELECT * FROM app.admin_list_users($1, $2, NULL, NULL, 1, NULL)', [
            w.A.ownerId,
            w.A.ownerId,
          ]),
          '42501',
        );
      } finally {
        await p.end();
      }
    }
  });

  it('a workspace owner with MFA and a live session reaches no console function; the victim is unchanged', async () => {
    // Promote A's owner to the strongest non-admin identity: MFA on, a live session.
    await w.auth.query('UPDATE identity.users SET two_factor_enabled = true WHERE id = $1', [w.A.ownerId]);
    const attacker = { userId: w.A.ownerId, sessionId: await createSessionRow(w.auth, w.A.ownerId) };
    expect((await console_.consoleState(attacker)).isAdmin).toBe(false);
    await expectPgError(console_.beginStepUp(attacker, null), '42501');
    for (const [name, call] of consoleCalls(attacker)) {
      await expectPgError(call(), '42501').catch((e: unknown) => {
        throw new Error(`${name}: ${String(e)}`);
      });
    }
    expect(await victimStatus()).toEqual({ status: 'active' });
  });

  it('an admin without a step-up of this session is refused by every console function', async () => {
    const admin = await steppedUpAdmin({ auth: w.auth, migrator, admin: adminRole });
    // A second session of the same admin has no step-up.
    const other = { userId: admin.userId, sessionId: await createSessionRow(w.auth, admin.userId) };
    for (const [name, call] of consoleCalls(other)) {
      await expectPgError(call(), '42501').catch((e: unknown) => {
        throw new Error(`${name}: ${String(e)}`);
      });
    }
    expect(await victimStatus()).toEqual({ status: 'active' });
    // The stepped-up session works (the probe above is not vacuous).
    await expect(
      console_.listUsers(admin, { query: null, before: null, limit: 1 }, null),
    ).resolves.toHaveLength(1);
  });
});
