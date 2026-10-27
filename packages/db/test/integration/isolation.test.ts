/**
 * Behavioural tenant isolation (SRS 5.3 items 2-5, SEC-01, SEC-10, FR-AUTH-08). Two workspaces A and B; every
 * check runs as app_user through PgBouncer in transaction mode, exactly as the dashboard will.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { type TenantDatabase } from '../../src/client';
import { InvalidScopeError } from '../../src/errors';
import { createSessionRow, steppedUpAdmin } from '../../src/testing';
import { uuidv7 } from '../../src/uuid';
import {
  asDefiner,
  createUser,
  expectPgError,
  pool,
  seedWorkspace,
  tenantDb,
  tenantTables,
  uniqueSlug,
  urls,
  type SeededWorkspace,
} from './helpers';

let db: TenantDatabase;
let admin: pg.Pool;
let auth: pg.Pool;
let rawApp: pg.Pool;
let migrator: pg.Pool;
let A: SeededWorkspace;
let B: SeededWorkspace;
let tables: string[];
const hash = () => randomBytes(32).toString('hex');

beforeAll(async () => {
  db = tenantDb();
  admin = pool(urls.bootstrap);
  auth = pool(urls.auth);
  rawApp = pool(urls.app, 2);
  migrator = pool(urls.migrator, 2);
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
  tables = await tenantTables(admin);
});
afterAll(async () => {
  await db.disconnect();
  await Promise.all([admin.end(), auth.end(), rawApp.end(), migrator.end()]);
});

describe('fail-closed context', () => {
  it('no context returns zero rows from every table, on re-used pooled connections', async () => {
    for (let i = 0; i < 20; i++) {
      for (const table of [...tables, 'workspaces']) {
        const { rows } = await rawApp.query(`SELECT count(*)::int AS n FROM app.${table}`);
        expect([table, rows[0].n]).toEqual([table, 0]);
      }
    }
  });

  it('a raw query outside withTenant has no context even on the same process (Spike B B-5)', async () => {
    const n = await db.withActor(
      A.ownerId,
      (tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM app.projects`,
    );
    expect(n[0]?.n).toBe(0);
  });

  it('rejects malformed ids before they reach set_config', async () => {
    await expect(db.withActor("x'; SET app.workspace_id = 'y", async () => 1)).rejects.toBeInstanceOf(
      InvalidScopeError,
    );
    await expect(db.resolveTenantScope(A.ownerId, 'not-a-uuid')).rejects.toBeInstanceOf(InvalidScopeError);
  });
});

describe('workspace scoping', () => {
  it('each workspace sees exactly its own rows in every tenant table (auto-discovered)', async () => {
    for (const seeded of [A, B]) {
      await db.withTenant(seeded.scope, async (tx) => {
        for (const table of tables) {
          const rows = await tx.$queryRawUnsafe<Array<{ mine: number; foreign: number }>>(
            `SELECT count(*) FILTER (WHERE workspace_id = $1::uuid)::int AS mine,
                    count(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1::uuid)::int AS foreign
               FROM app.${table}`,
            seeded.scope.workspaceId,
          );
          expect([table, rows[0]?.foreign]).toEqual([table, 0]);
          expect([table, (rows[0]?.mine ?? 0) > 0]).toEqual([table, true]);
        }
      });
    }
  });

  it('joins and nested relation loads never surface another workspace', async () => {
    await db.withTenant(A.scope, async (tx) => {
      const joined = await tx.$queryRaw<Array<{ workspace_id: string }>>`
        SELECT d.workspace_id FROM app.domains d JOIN app.projects p ON p.id = d.project_id
        UNION ALL SELECT d.workspace_id FROM app.domains d JOIN app.projects p ON p.id = ${B.projectId}::uuid`;
      expect(new Set(joined.map((r) => r.workspace_id))).toEqual(new Set([A.scope.workspaceId]));
      const nested = await tx.workspace.findMany({
        include: { projects: { include: { domains: true, contacts: true } }, memberships: true },
      });
      expect(nested.map((w) => w.id)).toEqual([A.scope.workspaceId]);
      expect(nested[0]?.projects.flatMap((p) => p.domains.map((d) => d.workspaceId))).toEqual([
        A.scope.workspaceId,
      ]);
    });
  });

  it('cross-tenant UPDATE / DELETE by id affect nothing, and RETURNING reveals nothing', async () => {
    await db.withTenant(A.scope, async (tx) => {
      const updated = await tx.project.updateMany({ where: { id: B.projectId }, data: { name: 'pwned' } });
      expect(updated.count).toBe(0);
      const returned = await tx.$queryRaw<
        unknown[]
      >`UPDATE app.projects SET name = 'pwned' WHERE id = ${B.projectId}::uuid RETURNING *`;
      expect(returned).toEqual([]);
      expect((await tx.membership.deleteMany({ where: { workspaceId: B.scope.workspaceId } })).count).toBe(0);
      expect((await tx.notification.deleteMany({ where: { userId: B.ownerId } })).count).toBe(0);
      expect(await tx.project.findUnique({ where: { id: B.projectId } })).toBeNull();
    });
    await db.withTenant(B.scope, async (tx) => {
      expect((await tx.project.findUniqueOrThrow({ where: { id: B.projectId } })).name).toBe('Site');
    });
  });

  it('WITH CHECK rejects inserting into another workspace', async () => {
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.project.create({ data: { workspaceId: B.scope.workspaceId, name: 'x' } }),
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.auditLog.create({
          data: { workspaceId: B.scope.workspaceId, actorType: 'user', action: 'x.y', result: 'success' },
        }),
      ),
      '42501',
    );
  });

  it('rows cannot be moved across workspaces (no UPDATE privilege on workspace_id)', async () => {
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) =>
          tx.$executeRaw`UPDATE app.projects SET workspace_id = ${B.scope.workspaceId}::uuid WHERE id = ${A.projectId}::uuid`,
      ),
      '42501',
    );
  });

  it('composite foreign keys stop a child row pointing at another workspace parent', async () => {
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) =>
          tx.$executeRaw`INSERT INTO app.client_contacts (workspace_id, project_id, name)
                       VALUES (${A.scope.workspaceId}::uuid, ${B.projectId}::uuid, 'x')`,
      ),
      '23503',
    );
    // A project of B without a subdomain, so the one-subdomain-per-project index cannot fire first.
    const bareB = await db.withTenant(B.scope, (tx) =>
      tx.project.create({ data: { workspaceId: B.scope.workspaceId, name: 'Bare' } }),
    );
    // S6: app_user has no INSERT on domains at all; the allocator refuses a project outside the context.
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) =>
          tx.$executeRaw`INSERT INTO app.domains (workspace_id, project_id, hostname, type)
                       VALUES (${A.scope.workspaceId}::uuid, ${bareB.id}::uuid, ${`${uniqueSlug('x')}.sites.test`}, 'subdomain')`,
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) =>
          tx.$queryRaw`SELECT * FROM app.allocate_platform_subdomain(${bareB.id}::uuid, ${uniqueSlug('x')})`,
      ),
      '42501',
    );
    await expectPgError(
      asDefiner(
        migrator,
        `INSERT INTO app.domains (workspace_id, project_id, hostname, type) VALUES ($1, $2, $3, 'subdomain')`,
        [A.scope.workspaceId, bareB.id, `${uniqueSlug('x')}.sites.test`],
      ),
      '23503',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.project.update({ where: { id: A.projectId }, data: { clientContactId: B.contactId } }),
      ),
      '23503',
    );
    // A notification recipient must be a member of the same workspace.
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.notification.createMany({
          data: [{ workspaceId: A.scope.workspaceId, userId: B.ownerId, type: 'x.y' }],
        }),
      ),
      '23503',
    );
  });

  it('global uniqueness holds across workspaces without revealing the other row', async () => {
    await expectPgError(
      asDefiner(
        migrator,
        `INSERT INTO app.domains (workspace_id, project_id, hostname, type) VALUES ($1, $2, $3, 'subdomain')`,
        [B.scope.workspaceId, B.projectId, A.hostname],
      ),
      '23505',
    );
    // Through the allocator, B asking for A's label gets a suffixed name of its own and learns nothing else (Q9).
    const label = A.hostname.split('.')[0]!;
    const rows = await db.withTenant(B.scope, async (tx) => {
      const p = await tx.project.create({ data: { workspaceId: B.scope.workspaceId, name: 'Same label' } });
      return tx.$queryRaw<Array<{ hostname: string }>>`
        SELECT hostname FROM app.allocate_platform_subdomain(${p.id}::uuid, ${label})`;
    });
    expect(rows[0]?.hostname).toMatch(new RegExp(`^${label}-[a-z0-9]{4}\\.sites\\.localhost$`));
  });
});

describe('actor context and the membership bridge (Spike F result 18)', () => {
  it('an actor sees only their own memberships and workspaces, and no tenant data', async () => {
    const actor = await createUser(auth);
    await db.withTenant(A.scope, (tx) =>
      tx.membership.create({ data: { workspaceId: A.scope.workspaceId, userId: actor, role: 'editor' } }),
    );
    await db.withTenant(B.scope, (tx) =>
      tx.membership.create({ data: { workspaceId: B.scope.workspaceId, userId: actor, role: 'viewer' } }),
    );
    await db.withActor(actor, async (tx) => {
      const memberships = await tx.membership.findMany({ orderBy: { role: 'asc' } });
      expect(memberships.map((m) => [m.workspaceId, m.role])).toEqual([
        [A.scope.workspaceId, 'editor'],
        [B.scope.workspaceId, 'viewer'],
      ]);
      expect(memberships.every((m) => m.userId === actor)).toBe(true);
      const workspaces = await tx.workspace.findMany({ select: { id: true } });
      expect(new Set(workspaces.map((w) => w.id))).toEqual(
        new Set([A.scope.workspaceId, B.scope.workspaceId]),
      );
      expect(await tx.project.count()).toBe(0);
      expect(await tx.auditLog.count()).toBe(0);
    });
    // Actor context alone cannot create memberships (no self-promotion or self-invite).
    await expectPgError(
      db.withActor(actor, (tx) =>
        tx.membership.create({ data: { workspaceId: A.scope.workspaceId, userId: actor, role: 'owner' } }),
      ),
      '42501',
    );
  });

  it('resolveTenantScope proves membership server-side and returns null for strangers', async () => {
    const stranger = await createUser(auth);
    expect(await db.resolveTenantScope(stranger, A.scope.workspaceId)).toBeNull();
    expect(await db.resolveTenantScope(A.ownerId, B.scope.workspaceId)).toBeNull();
    const scope = await db.resolveTenantScope(A.ownerId, A.scope.workspaceId);
    expect(scope).toMatchObject({
      workspaceId: A.scope.workspaceId,
      actorUserId: A.ownerId,
      role: 'owner',
      writable: true,
    });
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it('notifications are private to their recipient inside the workspace', async () => {
    const member = await createUser(auth);
    await db.withTenant(A.scope, async (tx) => {
      await tx.membership.create({
        data: { workspaceId: A.scope.workspaceId, userId: member, role: 'viewer' },
      });
      // Notifying someone else works without RETURNING; with RETURNING the SELECT policy hides the new row.
      await tx.notification.createMany({
        data: [{ workspaceId: A.scope.workspaceId, userId: member, type: 'project.created' }],
      });
    });
    const memberScope = await db.resolveTenantScope(member, A.scope.workspaceId);
    expect(memberScope?.role).toBe('viewer');
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.notification.create({ data: { workspaceId: A.scope.workspaceId, userId: member, type: 'x.y' } }),
      ),
      '42501',
    );
    await db.withTenant(memberScope!, async (tx) => {
      const mine = await tx.notification.findMany();
      expect(mine.map((n) => [n.userId, n.type])).toEqual([[member, 'project.created']]);
      expect(
        (await tx.notification.updateMany({ where: { userId: A.ownerId }, data: { readAt: new Date() } }))
          .count,
      ).toBe(0);
    });
  });
});

describe('suspension and scheduled deletion block writes (FR-WS-04)', () => {
  let adminRole: pg.Pool;
  let migrator: pg.Pool;
  let platformAdmin: { userId: string; sessionId: string };

  beforeAll(async () => {
    adminRole = pool(urls.admin, 2);
    migrator = pool(urls.migrator, 1);
    platformAdmin = await steppedUpAdmin({ auth, migrator, admin: adminRole });
  });
  afterAll(async () => {
    await Promise.all([adminRole.end(), migrator.end()]);
  });

  const setStatus = (
    admin: { userId: string; sessionId: string },
    ws: string,
    status: string,
    reason = 'abuse report #1',
  ) =>
    adminRole.query<{ changed: boolean }>(
      'SELECT changed FROM app.admin_set_workspace_status($1, $2, $3, $4, $5, $6)',
      [admin.userId, admin.sessionId, ws, status, reason, 'corr-test'],
    );

  it('only an active platform admin with MFA can suspend, with a reason', async () => {
    const plainUser = await createUser(auth, { mfa: true });
    const adminWithoutMfa = await createUser(auth);
    await migrator.query('SELECT app.operator_grant_platform_admin($1, $2)', [adminWithoutMfa, 'no mfa yet']);
    const plain = { userId: plainUser, sessionId: await createSessionRow(auth, plainUser) };
    const noMfa = { userId: adminWithoutMfa, sessionId: await createSessionRow(auth, adminWithoutMfa) };
    await expectPgError(setStatus(plain, B.scope.workspaceId, 'suspended'), '42501');
    await expectPgError(setStatus(noMfa, B.scope.workspaceId, 'suspended'), '42501');
    // S8: the step-up of a session cannot be started without MFA either.
    await expectPgError(
      adminRole.query('SELECT app.admin_step_up_begin($1, $2, $3)', [noMfa.userId, noMfa.sessionId, 'x']),
      '42501',
    );
    await expectPgError(setStatus(platformAdmin, B.scope.workspaceId, 'suspended', ''), '22023');
    await expectPgError(setStatus(platformAdmin, uuidv7(), 'suspended'), 'P0002');
    // A revoked admin loses the capability.
    await migrator.query('SELECT app.operator_revoke_platform_admin($1, $2)', [adminWithoutMfa, 'cleanup']);
    const { rows } = await migrator.query('SELECT app.operator_revoke_platform_admin($1, $2) AS changed', [
      adminWithoutMfa,
      'again',
    ]);
    expect(rows[0].changed).toBe(false);
  });

  it('a suspended workspace keeps reads and audit appends but rejects every other write', async () => {
    const { rows } = await setStatus(platformAdmin, B.scope.workspaceId, 'suspended');
    expect(rows[0]?.changed).toBe(true);
    expect((await setStatus(platformAdmin, B.scope.workspaceId, 'suspended')).rows[0]?.changed).toBe(false);

    const scope = await db.resolveTenantScope(B.ownerId, B.scope.workspaceId);
    expect(scope?.writable).toBe(false);
    await db.withTenant(scope!, async (tx) => {
      expect(await tx.project.count()).toBeGreaterThan(0);
      await tx.auditLog.create({
        data: {
          workspaceId: B.scope.workspaceId,
          actorType: 'user',
          action: 'project.create',
          result: 'denied',
        },
      });
      const trail = await tx.auditLog.findMany({ where: { action: 'admin.workspace.suspended' } });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        actorType: 'platform_admin',
        actorId: platformAdmin.userId,
        correlationId: 'corr-test',
      });
    });
    await expectPgError(
      db.withTenant(scope!, (tx) =>
        tx.project.create({ data: { workspaceId: B.scope.workspaceId, name: 'x' } }),
      ),
      '42501',
    );
    // UPDATE/DELETE policies filter the rows instead of raising: nothing changes.
    expect(
      await db.withTenant(
        scope!,
        (tx) => tx.$executeRaw`UPDATE app.projects SET name = 'x' WHERE id = ${B.projectId}::uuid`,
      ),
    ).toBe(0);
    expect(
      await db.withTenant(
        scope!,
        (tx) => tx.$executeRaw`DELETE FROM app.memberships WHERE user_id = ${B.ownerId}::uuid`,
      ),
    ).toBe(0);
    await expectPgError(
      db.withTenant(scope!, (tx) =>
        tx.workspace.update({ where: { id: B.scope.workspaceId }, data: { name: 'x' } }),
      ),
      'P2025',
    );

    expect(
      (await setStatus(platformAdmin, B.scope.workspaceId, 'active', 'appeal accepted')).rows[0]?.changed,
    ).toBe(true);
    await db.withTenant(B.scope, (tx) =>
      tx.project.update({ where: { id: B.projectId }, data: { name: 'Site' } }),
    );
  });

  it('app_user cannot change workspace status itself', async () => {
    await expectPgError(
      db.withTenant(A.scope, (tx) => tx.$executeRaw`UPDATE app.workspaces SET status = 'active'`),
      '42501',
    );
    // Prisma sends enum defaults, so status is insertable; the INSERT policies pin the only allowed values.
    const owner = await createUser(auth);
    await expectPgError(
      db.withNewWorkspace(owner, (tx, sc) =>
        tx.workspace.create({
          data: {
            id: sc.workspaceId,
            name: 'x',
            slug: uniqueSlug(),
            status: 'suspended',
            suspendedAt: new Date(),
          },
        }),
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.project.create({ data: { workspaceId: A.scope.workspaceId, name: 'x', status: 'live' } }),
      ),
      '42501',
    );
  });

  it('a scheduled deletion blocks writes until the owner cancels it', async () => {
    const now = new Date();
    await db.withTenant(A.scope, (tx) =>
      tx.workspace.update({
        where: { id: A.scope.workspaceId },
        data: { deletedAt: now, scheduledPurgeAt: new Date(now.getTime() + 30 * 86_400_000) },
      }),
    );
    expect((await db.resolveTenantScope(A.ownerId, A.scope.workspaceId))?.writable).toBe(false);
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.project.create({ data: { workspaceId: A.scope.workspaceId, name: 'x' } }),
      ),
      '42501',
    );
    await db.withTenant(A.scope, (tx) =>
      tx.workspace.update({
        where: { id: A.scope.workspaceId },
        data: { deletedAt: null, scheduledPurgeAt: null },
      }),
    );
    await db.withTenant(A.scope, (tx) =>
      tx.project.create({ data: { workspaceId: A.scope.workspaceId, name: 'after cancel' } }),
    );
  });
});

describe('append-only audit trail (FR-AUD-01)', () => {
  it('app_user can neither update nor delete audit rows', async () => {
    await expectPgError(
      db.withTenant(A.scope, (tx) => tx.$executeRaw`UPDATE app.audit_logs SET action = 'x.y'`),
      '42501',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) => tx.$executeRaw`DELETE FROM app.audit_logs`),
      '42501',
    );
  });

  it('even the owner cannot truncate it', async () => {
    const migrator = pool(urls.migrator, 1);
    try {
      await expectPgError(migrator.query('TRUNCATE app.audit_logs'), '42501');
    } finally {
      await migrator.end();
    }
  });

  it('platform events go through record_platform_audit only, invisible to tenants', async () => {
    const user = await createUser(auth);
    const { rows } = await auth.query(
      `SELECT app.record_platform_audit('user', $1, 'auth.session.created', 'session', NULL, 'success', 'corr-1',
                                        '{"method":"password"}'::jsonb, '203.0.113.7', 'vitest') AS id`,
      [user],
    );
    expect(rows[0].id).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/);
    await expectPgError(
      auth.query(
        `SELECT app.record_platform_audit('platform_admin', $1, 'x.y', NULL, NULL, 'success', NULL, NULL, NULL, NULL)`,
        [user],
      ),
      '22023',
    );
    await expectPgError(
      auth.query(`INSERT INTO app.audit_logs (actor_type, action, result) VALUES ('user', 'x.y', 'success')`),
      '42501',
    );
    await expectPgError(
      auth.query(
        `SELECT app.record_platform_audit('user', $1, 'Bad Action', NULL, NULL, 'success', NULL, NULL, NULL, NULL)`,
        [user],
      ),
      '23514',
    );
    await db.withTenant(A.scope, async (tx) => {
      expect(await tx.auditLog.count({ where: { workspaceId: null } })).toBe(0);
    });
  });
});

describe('integrity constraints', () => {
  it('rejects malformed slugs, hostnames, invitations and oversized metadata', async () => {
    const owner = await createUser(auth);
    for (const slug of ['ab', 'Upper', '-lead', 'trail-', 'dou--ble', 'a'.repeat(49), 'sp ace']) {
      await expectPgError(
        db.withNewWorkspace(owner, (tx, s) =>
          tx.workspace.create({ data: { id: s.workspaceId, name: 'x', slug } }),
        ),
        '23514',
      );
    }
    await expectPgError(
      db.withNewWorkspace(owner, (tx, s) =>
        tx.workspace.create({ data: { id: s.workspaceId, name: 'x', slug: B.hostname.split('.')[0]! } }),
      ),
      '23505',
    );
    const project = await db.withTenant(A.scope, (tx) =>
      tx.project.create({ data: { workspaceId: A.scope.workspaceId, name: 'Second' } }),
    );
    // Host-name CHECKs, reached as svc_definer (the only role that may insert domains since S6), plus the
    // reserved-label CHECK (Q9).
    for (const hostname of [
      'UPPER.sites.test',
      'no_underscore.sites.test',
      'trailing.dot.',
      'nodot',
      '-x.sites.test',
      'admin.sites.test',
      'www.sites.test',
    ]) {
      await expectPgError(
        asDefiner(
          migrator,
          `INSERT INTO app.domains (workspace_id, project_id, hostname, type) VALUES ($1, $2, $3, 'subdomain')`,
          [A.scope.workspaceId, project.id, hostname],
        ),
        '23514',
      );
    }
    // The allocator validates its label before building a host name.
    for (const label of ['UP', 'a', 'x_y', '-lead', 'dou--ble', 'a'.repeat(41)]) {
      await expectPgError(
        db.withTenant(
          A.scope,
          (tx) => tx.$queryRaw`SELECT * FROM app.allocate_platform_subdomain(${project.id}::uuid, ${label})`,
        ),
        '22023',
      );
    }
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.domain.create({
          data: {
            workspaceId: A.scope.workspaceId,
            projectId: A.projectId,
            hostname: `${uniqueSlug('c')}.example.com`,
            type: 'custom',
          },
        }),
      ),
      '42501',
    );
    // One live platform subdomain per project: the index stops a second row, and the allocator is idempotent.
    await expectPgError(
      asDefiner(
        migrator,
        `INSERT INTO app.domains (workspace_id, project_id, hostname, type) VALUES ($1, $2, $3, 'subdomain')`,
        [A.scope.workspaceId, A.projectId, `${uniqueSlug('d')}.sites.test`],
      ),
      '23505',
    );
    const again = await db.withTenant(
      A.scope,
      (tx) => tx.$queryRaw<Array<{ domain_id: string; hostname: string }>>`
        SELECT domain_id, hostname FROM app.allocate_platform_subdomain(${A.projectId}::uuid, ${uniqueSlug('other')})`,
    );
    expect(again).toEqual([{ domain_id: A.domainId, hostname: A.hostname }]);
    const email = `new-${uniqueSlug()}@example.test`;
    const invite = (role: 'owner' | 'admin', tokenHash: string, to = email) =>
      db.withTenant(A.scope, (tx) =>
        tx.invitation.create({
          data: {
            workspaceId: A.scope.workspaceId,
            email: to,
            role,
            tokenHash,
            expiresAt: new Date(Date.now() + 86_400_000),
            invitedBy: A.ownerId,
          },
        }),
      );
    await expectPgError(invite('owner', hash()), '23514');
    await expectPgError(invite('admin', 'not-a-hash'), '23514');
    await expectPgError(invite('admin', hash(), 'Mixed@Example.test'), '23514');
    await invite('admin', hash());
    await expectPgError(invite('admin', hash()), '23505');
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.auditLog.create({
          data: {
            workspaceId: A.scope.workspaceId,
            actorType: 'user',
            action: 'x.y',
            result: 'success',
            metadata: { blob: 'x'.repeat(20_000) },
          },
        }),
      ),
      '23514',
    );
  });

  it('app.uuid_generate_v7 produces time-ordered version-7 ids', async () => {
    const ids = await db.withTenant(A.scope, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await tx.auditLog.create({
          data: {
            workspaceId: A.scope.workspaceId,
            actorType: 'system',
            action: 'test.uuid',
            result: 'success',
          },
        });
        out.push(row.id);
        await tx.$executeRaw`SELECT pg_sleep(0.002)`;
      }
      return out;
    });
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
  });
});
