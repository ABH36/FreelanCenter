/**
 * P1 S8: the admin console's database layer (FR-ADM-01, FR-ADM-02, SEC-17). Every call goes through the
 * app_admin client (`@platform/db/admin`) against the definer functions of migration p1_s8_admin_console, the
 * way the dashboard calls them. The step-up code check itself is the dashboard's (Better Auth); here a verified
 * or failed result is recorded directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { type AdminDatabase, type AdminPrincipal, createAdminDatabase } from '../../src/admin';
import type { TenantDatabase } from '../../src/client';
import { createSessionRow, stepUp, steppedUpAdmin } from '../../src/testing';
import { uuidv7 } from '../../src/uuid';
import {
  createUser,
  expectPgError,
  pool,
  seedWorkspace,
  tenantDb,
  urls,
  type SeededWorkspace,
} from './helpers';

let db: TenantDatabase;
let auth: pg.Pool;
let migrator: pg.Pool;
let adminRole: pg.Pool;
let console_: AdminDatabase;
let A: SeededWorkspace;
let B: SeededWorkspace;
let admin: AdminPrincipal;

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  migrator = pool(urls.migrator, 1);
  adminRole = pool(urls.admin, 2);
  console_ = createAdminDatabase({ connectionString: urls.admin });
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
  admin = await steppedUpAdmin({ auth, migrator, admin: adminRole });
});
afterAll(async () => {
  await console_.close();
  await db.disconnect();
  await Promise.all([auth.end(), migrator.end(), adminRole.end()]);
});

/** Runs read-only SQL as svc_definer (migrator holds SET on it): not through the function under test. */
async function asDefinerRead<R extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<R[]> {
  const client = await migrator.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL ROLE svc_definer');
    return (await client.query<R>(sql, params)).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Platform/admin audit rows of one actor, newest first. */
const auditOf = (actorId: string, action: string) =>
  asDefinerRead<{ workspace_id: string | null; result: string; metadata: Record<string, unknown> }>(
    'SELECT workspace_id, result, metadata FROM app.audit_logs WHERE actor_id = $1 AND action = $2 ORDER BY id DESC',
    [actorId, action],
  );

/** A granted admin with MFA and a live session, but no step-up yet. */
async function freshAdmin(): Promise<AdminPrincipal> {
  const userId = await createUser(auth, { mfa: true });
  await migrator.query('SELECT app.operator_grant_platform_admin($1, $2)', [userId, 'S8 test']);
  return { userId, sessionId: await createSessionRow(auth, userId) };
}

const allCalls = (p: AdminPrincipal): Array<() => Promise<unknown>> => [
  () => console_.listWorkspaces(p, { query: null, status: null, before: null, limit: 5 }, null),
  () => console_.getWorkspace(p, A.scope.workspaceId, null),
  () => console_.listUsers(p, { query: null, before: null, limit: 5 }, null),
  () => console_.listAudit(p, { action: null, actorId: null, before: null, limit: 5 }),
  () =>
    console_.setWorkspaceStatus(
      p,
      { workspaceId: A.scope.workspaceId, status: 'suspended', reason: 'probe' },
      null,
    ),
];

describe('guard: platform admin + TOTP + live session (+ step-up), checked in the database', () => {
  it('the client refuses any URL that is not app_admin, and checks its role', async () => {
    expect(() => createAdminDatabase({ connectionString: urls.app })).toThrow();
    await expect(console_.verifyRole()).resolves.toBeUndefined();
  });

  it('console state: true only for an active, MFA-enrolled admin on a live session of their own', async () => {
    const plain = await createUser(auth, { mfa: true });
    const plainSession = await createSessionRow(auth, plain);
    expect((await console_.consoleState({ userId: plain, sessionId: plainSession })).isAdmin).toBe(false);

    const noMfa = await createUser(auth);
    await migrator.query('SELECT app.operator_grant_platform_admin($1, $2)', [noMfa, 'no MFA']);
    const noMfaSession = await createSessionRow(auth, noMfa);
    expect((await console_.consoleState({ userId: noMfa, sessionId: noMfaSession })).isAdmin).toBe(false);

    const fresh = await freshAdmin();
    expect(await console_.consoleState(fresh)).toEqual({
      isAdmin: true,
      stepUpUntil: null,
      lockedUntil: null,
    });
    // Someone else's session, an expired session, a revoked grant.
    expect((await console_.consoleState({ userId: fresh.userId, sessionId: plainSession })).isAdmin).toBe(
      false,
    );
    const expired = await createSessionRow(auth, fresh.userId, -1);
    expect((await console_.consoleState({ userId: fresh.userId, sessionId: expired })).isAdmin).toBe(false);
    await migrator.query('SELECT app.operator_revoke_platform_admin($1, $2)', [fresh.userId, 'S8 test']);
    expect((await console_.consoleState(fresh)).isAdmin).toBe(false);
  });

  it('without a step-up every console function is refused (42501), and nothing is written', async () => {
    const fresh = await freshAdmin();
    for (const call of allCalls(fresh)) await expectPgError(call(), '42501');
    const plain = await createUser(auth, { mfa: true });
    for (const call of allCalls({ userId: plain, sessionId: await createSessionRow(auth, plain) })) {
      await expectPgError(call(), '42501');
    }
    expect(await auditOf(fresh.userId, 'admin.workspace.suspended')).toEqual([]);
    expect(await auditOf(fresh.userId, 'admin.workspace.viewed')).toEqual([]);
  });

  it('a step-up belongs to one session and dies with it; an expired step-up is refused', async () => {
    const fresh = await freshAdmin();
    await stepUp(adminRole, fresh);
    const state = await console_.consoleState(fresh);
    expect(state.stepUpUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(state.stepUpUntil!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    await expect(
      console_.listUsers(fresh, { query: null, before: null, limit: 1 }, null),
    ).resolves.toHaveLength(1);

    // Another session of the same admin is not stepped up.
    const other = { userId: fresh.userId, sessionId: await createSessionRow(auth, fresh.userId) };
    await expectPgError(console_.listUsers(other, { query: null, before: null, limit: 1 }, null), '42501');
    // Signing out (Better Auth deletes the session row) ends the console at once.
    await auth.query('DELETE FROM identity.sessions WHERE id = $1', [fresh.sessionId]);
    await expectPgError(console_.listUsers(fresh, { query: null, before: null, limit: 1 }, null), '42501');

    // 15 minutes later. No role may change a verified row (svc_definer updates pending rows only), so the
    // owner moves it back with FORCE RLS lifted inside one transaction that restores it before commit.
    await stepUp(adminRole, other);
    const owner = await migrator.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE app.admin_step_ups NO FORCE ROW LEVEL SECURITY');
      await owner.query(
        `UPDATE app.admin_step_ups SET verified_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes'
          WHERE session_id = $1`,
        [other.sessionId],
      );
      await owner.query('ALTER TABLE app.admin_step_ups FORCE ROW LEVEL SECURITY');
      await owner.query('COMMIT');
    } finally {
      owner.release();
    }
    await expectPgError(console_.listUsers(other, { query: null, before: null, limit: 1 }, null), '42501');
    expect((await console_.consoleState(other)).stepUpUntil).toBeNull();
  });

  it('an attempt is finished once, only by its own admin and session, and both outcomes are audited', async () => {
    const fresh = await freshAdmin();
    const attempt = (await console_.beginStepUp(fresh, 'corr-s8'))!;
    expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
    const elsewhere = { userId: fresh.userId, sessionId: await createSessionRow(auth, fresh.userId) };
    await expectPgError(console_.finishStepUp(elsewhere, attempt, true, null), 'P0002');
    await expectPgError(console_.finishStepUp(fresh, uuidv7(), true, null), 'P0002');
    expect(await console_.finishStepUp(fresh, attempt, false, 'corr-s8')).toBeNull();
    await expectPgError(console_.finishStepUp(fresh, attempt, true, null), 'P0002');
    expect((await console_.consoleState(fresh)).stepUpUntil).toBeNull();

    const second = (await console_.beginStepUp(fresh, null))!;
    expect(await console_.finishStepUp(fresh, second, true, null)).toBeInstanceOf(Date);
    expect(await auditOf(fresh.userId, 'admin.step_up.failed')).toEqual([
      { workspace_id: null, result: 'failure', metadata: { method: 'totp' } },
    ]);
    expect(await auditOf(fresh.userId, 'admin.step_up.verified')).toHaveLength(1);
  });

  it('five failed or abandoned attempts in 15 minutes lock the step-up; the refusal is audited', async () => {
    const fresh = await freshAdmin();
    for (let i = 0; i < 3; i++) {
      await console_.finishStepUp(fresh, (await console_.beginStepUp(fresh, null))!, false, null);
    }
    // Two attempts that never finish (a request that died between begin and finish) count as well.
    await console_.beginStepUp(fresh, null);
    await console_.beginStepUp(fresh, null);
    expect(await console_.beginStepUp(fresh, null)).toBeNull();
    const state = await console_.consoleState(fresh);
    expect(state.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(state.stepUpUntil).toBeNull();
    expect(await auditOf(fresh.userId, 'admin.step_up.locked')).toEqual([
      { workspace_id: null, result: 'denied', metadata: {} },
    ]);
  });

  it('parallel attempts cannot pass the lockout together', async () => {
    const fresh = await freshAdmin();
    const ids = await Promise.all(Array.from({ length: 8 }, () => console_.beginStepUp(fresh, null)));
    expect(ids.filter(Boolean)).toHaveLength(5);
  });

  it('no application role can read or write the step-up table', async () => {
    for (const url of [urls.app, urls.auth, urls.public, urls.admin]) {
      const p = pool(url, 1);
      try {
        await expectPgError(p.query('SELECT 1 FROM app.admin_step_ups LIMIT 1'), '42501');
        await expectPgError(
          p.query(
            `INSERT INTO app.admin_step_ups (user_id, session_id, status) VALUES ($1, $2, 'verified')`,
            [admin.userId, uuidv7()],
          ),
          '42501',
        );
      } finally {
        await p.end();
      }
    }
  });
});

describe('FR-ADM-01: workspaces and users with data minimisation', () => {
  it('workspaces: browse, search by name / address prefix / id, status filter, keyset paging', async () => {
    const all = await console_.listWorkspaces(
      admin,
      { query: null, status: null, before: null, limit: 100 },
      null,
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(all[0]!).sort()).toEqual(
      [
        'createdAt',
        'deletionScheduled',
        'id',
        'memberCount',
        'name',
        'projectCount',
        'slug',
        'status',
        'suspendedAt',
      ].sort(),
    );
    const slugA = (await console_.getWorkspace(admin, A.scope.workspaceId, null))!.slug;
    const byName = await console_.listWorkspaces(
      admin,
      { query: `WORKSPACE ${slugA}`, status: null, before: null, limit: 10 },
      null,
    );
    expect(byName.map((w) => w.id)).toEqual([A.scope.workspaceId]);
    expect(byName[0]).toMatchObject({
      memberCount: 1,
      projectCount: 1,
      status: 'active',
      deletionScheduled: false,
    });
    const byPrefix = await console_.listWorkspaces(
      admin,
      { query: slugA.slice(0, -1), status: null, before: null, limit: 100 },
      null,
    );
    expect(byPrefix.map((w) => w.id)).toContain(A.scope.workspaceId);
    const byId = await console_.listWorkspaces(
      admin,
      { query: B.scope.workspaceId.toUpperCase(), status: null, before: null, limit: 10 },
      null,
    );
    expect(byId.map((w) => w.id)).toEqual([B.scope.workspaceId]);
    // LIKE wildcards are literal: '%' and '_' match nothing special.
    expect(
      await console_.listWorkspaces(admin, { query: '%', status: null, before: null, limit: 10 }, null),
    ).toEqual([]);
    expect(
      await console_.listWorkspaces(admin, { query: '_', status: null, before: null, limit: 10 }, null),
    ).toEqual([]);
    await expectPgError(
      console_.listWorkspaces(admin, { query: 'x'.repeat(101), status: null, before: null, limit: 10 }, null),
      '22023',
    );
    const first = await console_.listWorkspaces(
      admin,
      { query: null, status: null, before: null, limit: 1 },
      null,
    );
    const next = await console_.listWorkspaces(
      admin,
      { query: null, status: null, before: first[0]!.id, limit: 1 },
      null,
    );
    expect(next[0]!.id < first[0]!.id).toBe(true);
    expect(
      await console_.listWorkspaces(admin, { query: null, status: null, before: null, limit: 1000 }, null),
    ).toHaveLength(Math.min(all.length, 100));
  });

  it('a search is audited with its kind and length, never its text; browsing is not', async () => {
    const searcher = await steppedUpAdmin({ auth, migrator, admin: adminRole });
    await console_.listWorkspaces(
      searcher,
      { query: null, status: null, before: null, limit: 1 },
      'corr-browse',
    );
    await console_.listWorkspaces(
      searcher,
      { query: 'secret-name', status: 'active', before: null, limit: 1 },
      'corr-q',
    );
    const rows = await auditOf(searcher.userId, 'admin.workspaces.searched');
    expect(rows).toEqual([
      {
        workspace_id: null,
        result: 'success',
        metadata: { query_kind: 'text', query_length: 11, status: 'active' },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('one workspace: masked owner addresses, projects as status + host names only; the view is audited', async () => {
    const viewer = await steppedUpAdmin({ auth, migrator, admin: adminRole });
    const ws = (await console_.getWorkspace(viewer, A.scope.workspaceId, 'corr-view'))!;
    expect(ws.owners).toEqual([{ userId: A.ownerId, email: 'u***@example.test' }]);
    expect(ws.projects).toEqual([{ id: A.projectId, status: 'draft', hosts: [A.hostname] }]);
    expect(ws).toMatchObject({
      memberCount: 1,
      status: 'active',
      suspendedReason: null,
      deletionScheduledAt: null,
    });
    // No client contact, project name or member e-mail anywhere in the answer.
    expect(JSON.stringify(ws)).not.toMatch(/client@example\.test|"Site"|"Client"|user-/);
    expect(await auditOf(viewer.userId, 'admin.workspace.viewed')).toEqual([
      { workspace_id: null, result: 'success', metadata: {} },
    ]);
    expect(await console_.getWorkspace(viewer, uuidv7(), null)).toBeNull();
    expect(await auditOf(viewer.userId, 'admin.workspace.viewed')).toHaveLength(1);
  });

  it('users: masked addresses and no names; exact address or id only, never a fragment', async () => {
    const searcher = await steppedUpAdmin({ auth, migrator, admin: adminRole });
    const email = `user-${A.ownerId}@example.test`;
    const [row] = await console_.listUsers(
      searcher,
      { query: email.toUpperCase(), before: null, limit: 10 },
      null,
    );
    expect(row).toEqual({
      id: A.ownerId,
      emailMasked: 'u***@example.test',
      status: 'active',
      emailVerified: true,
      twoFactorEnabled: false,
      createdAt: expect.any(Date),
      workspaceCount: 1,
      platformAdmin: false,
    });
    expect(
      (await console_.listUsers(searcher, { query: A.ownerId, before: null, limit: 10 }, null)).map(
        (u) => u.id,
      ),
    ).toEqual([A.ownerId]);
    const [me] = await console_.listUsers(
      searcher,
      { query: searcher.userId, before: null, limit: 10 },
      null,
    );
    expect(me).toMatchObject({ platformAdmin: true, twoFactorEnabled: true });
    expect(
      await console_.listUsers(searcher, { query: 'nobody@example.test', before: null, limit: 10 }, null),
    ).toEqual([]);
    await expectPgError(
      console_.listUsers(searcher, { query: 'user-', before: null, limit: 10 }, null),
      '22023',
    );
    await expectPgError(
      console_.listUsers(searcher, { query: 'u'.repeat(255), before: null, limit: 10 }, null),
      '22023',
    );
    const browse = await console_.listUsers(searcher, { query: null, before: null, limit: 3 }, null);
    expect(browse.every((u) => /^.\*\*\*@/.test(u.emailMasked))).toBe(true);
    const audit = await auditOf(searcher.userId, 'admin.users.searched');
    expect(audit.map((r) => r.metadata)).toEqual([
      { query_kind: 'email', query_length: 'nobody@example.test'.length },
      { query_kind: 'id', query_length: 36 },
      { query_kind: 'id', query_length: 36 },
      { query_kind: 'email', query_length: email.length },
    ]);
    expect(JSON.stringify(audit)).not.toContain('example.test');
  });
});

describe('FR-ADM-02: suspend / unsuspend with a reason, invalidation in the same transaction (S7 D12)', () => {
  it('reason required; unknown workspace; unchanged status writes nothing', async () => {
    await expectPgError(
      console_.setWorkspaceStatus(
        admin,
        { workspaceId: B.scope.workspaceId, status: 'suspended', reason: '  ' },
        null,
      ),
      '22023',
    );
    await expectPgError(
      console_.setWorkspaceStatus(
        admin,
        { workspaceId: uuidv7(), status: 'suspended', reason: 'abuse' },
        null,
      ),
      'P0002',
    );
    expect(
      await console_.setWorkspaceStatus(
        admin,
        { workspaceId: B.scope.workspaceId, status: 'active', reason: 'noop' },
        null,
      ),
    ).toEqual({ changed: false, outboxIds: [] });
  });

  it('suspension writes one sites.hosts.changed.v1 row per live project, ids only, plus the audit row', async () => {
    // A second and a soft-deleted project in B.
    const [second, gone] = await db.withTenant(B.scope, async (tx) => {
      const p2 = await tx.project.create({ data: { workspaceId: B.scope.workspaceId, name: 'Second' } });
      const p3 = await tx.project.create({ data: { workspaceId: B.scope.workspaceId, name: 'Gone' } });
      await tx.project.update({ where: { id: p3.id }, data: { deletedAt: new Date() } });
      return [p2.id, p3.id];
    });
    const result = await console_.setWorkspaceStatus(
      admin,
      { workspaceId: B.scope.workspaceId, status: 'suspended', reason: '  phishing report #42 ' },
      'corr-suspend',
    );
    expect(result.changed).toBe(true);
    expect(result.outboxIds).toHaveLength(2);
    const rows = await db.withTenant(B.scope, (tx) =>
      tx.outboxEvent.findMany({ where: { id: { in: result.outboxIds } } }),
    );
    expect(rows.map((r) => (r.payload as { projectId: string }).projectId).sort()).toEqual(
      [B.projectId, second].sort(),
    );
    expect(rows.map((r) => (r.payload as { projectId: string }).projectId)).not.toContain(gone);
    for (const r of rows) {
      expect(r).toMatchObject({ event: 'sites.hosts.changed.v1', attempts: 0, dispatchedAt: null });
      expect(r.payload).toEqual({ workspaceId: B.scope.workspaceId, projectId: expect.any(String) });
    }
    const [audit] = await auditOf(admin.userId, 'admin.workspace.suspended');
    expect(audit).toEqual({
      workspace_id: B.scope.workspaceId,
      result: 'success',
      metadata: { reason: 'phishing report #42', previous_status: 'active', projects: 2 },
    });
    const ws = (await console_.getWorkspace(admin, B.scope.workspaceId, null))!;
    expect(ws).toMatchObject({ status: 'suspended', suspendedReason: 'phishing report #42' });
    expect(ws.suspendedAt).toBeInstanceOf(Date);
    expect(
      (
        await console_.listWorkspaces(
          admin,
          { query: null, status: 'suspended', before: null, limit: 100 },
          null,
        )
      ).map((w) => w.id),
    ).toContain(B.scope.workspaceId);

    // The workspace owner sees the suspension in their own audit log (FR-AUD-01), not the platform rows.
    const ownerScope = (await db.resolveTenantScope(B.ownerId, B.scope.workspaceId))!;
    const ownerView = await db.withTenant(ownerScope, (tx) =>
      tx.auditLog.findMany({ where: { actorType: 'platform_admin' }, select: { action: true } }),
    );
    expect(ownerView.map((r) => r.action)).toEqual(['admin.workspace.suspended']);

    const back = await console_.setWorkspaceStatus(
      admin,
      { workspaceId: B.scope.workspaceId, status: 'active', reason: 'appeal accepted' },
      null,
    );
    expect(back).toMatchObject({ changed: true });
    expect(back.outboxIds).toHaveLength(2);
    expect((await console_.getWorkspace(admin, B.scope.workspaceId, null))!).toMatchObject({
      status: 'active',
      suspendedReason: null,
      suspendedAt: null,
    });
  });

  it('svc_definer may insert only fresh rows of that one event into the outbox', async () => {
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE svc_definer');
      await expectPgError(
        client.query(
          `INSERT INTO app.outbox_events (id, workspace_id, event, payload) VALUES ($1, $2, 'notification.email.requested.v1', '{}')`,
          [uuidv7(), A.scope.workspaceId],
        ),
        '42501',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('admin audit viewer: platform rows and admin-written rows only, no IP or user agent', () => {
  it('shows step-ups, searches and suspensions; hides tenant rows of users; filters by action and actor', async () => {
    const rows = await console_.listAudit(admin, {
      action: 'admin.',
      actorId: admin.userId,
      before: null,
      limit: 100,
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('admin.step_up.verified');
    expect(actions).toContain('admin.workspace.suspended');
    expect(rows.every((r) => r.actorId === admin.userId && r.action.startsWith('admin.'))).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'action',
        'actorId',
        'actorType',
        'correlationId',
        'createdAt',
        'id',
        'metadata',
        'result',
        'targetId',
        'targetType',
        'workspaceId',
      ].sort(),
    );
    const suspended = rows.find((r) => r.action === 'admin.workspace.suspended')!;
    expect(suspended).toMatchObject({ workspaceId: B.scope.workspaceId, correlationId: 'corr-suspend' });

    // A tenant row written by a user (seedWorkspace's workspace.created) is not visible.
    const tenant = await console_.listAudit(admin, {
      action: 'workspace.created',
      actorId: A.ownerId,
      before: null,
      limit: 10,
    });
    expect(tenant).toEqual([]);
    // Platform rows of other actors are (operator grants).
    const grants = await console_.listAudit(admin, {
      action: 'admin.platform_admin.granted',
      actorId: null,
      before: null,
      limit: 5,
    });
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((r) => r.workspaceId === null)).toBe(true);

    const page1 = await console_.listAudit(admin, { action: null, actorId: null, before: null, limit: 2 });
    const page2 = await console_.listAudit(admin, {
      action: null,
      actorId: null,
      before: page1[1]!.id,
      limit: 2,
    });
    expect(page2[0]!.id < page1[1]!.id).toBe(true);
    await expectPgError(
      console_.listAudit(admin, { action: "x' OR 1=1", actorId: null, before: null, limit: 1 }),
      '22023',
    );
  });
});
