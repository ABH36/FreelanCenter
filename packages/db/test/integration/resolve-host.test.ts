/**
 * P1 S7: `app.resolve_host`, the visitor role's only function (SRS 4.3, 5.3 item 1; FR-DOM-07, FR-WS-04).
 * Every lookup runs as app_public through PgBouncer, the way apps/sites calls it. State changes are made the
 * way the product makes them: project status through app_user (trigger-checked), suspension through
 * `app.admin_set_workspace_status` as app_admin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { TenantDatabase, TenantScope } from '../../src/client';
import { createPublicDatabase, type PublicDatabase } from '../../src/public';
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
let publicRole: pg.Pool;
let adminRole: pg.Pool;
let migrator: pg.Pool;
let visitor: PublicDatabase;
let A: SeededWorkspace;
let B: SeededWorkspace;
let platformAdmin: string;

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  publicRole = pool(urls.public, 1);
  adminRole = pool(urls.admin, 1);
  migrator = pool(urls.migrator, 1);
  visitor = createPublicDatabase({ connectionString: urls.public });
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
  platformAdmin = await createUser(auth, { mfa: true });
  await migrator.query('SELECT app.operator_grant_platform_admin($1, $2)', [
    platformAdmin,
    'S7 resolve_host test',
  ]);
});
afterAll(async () => {
  await Promise.all([
    db.disconnect(),
    auth.end(),
    publicRole.end(),
    adminRole.end(),
    migrator.end(),
    visitor.close(),
  ]);
});

const resolve = async (host: string | null) => {
  const { rows } = await publicRole.query(
    'SELECT outcome, workspace_id, project_id FROM app.resolve_host($1)',
    [host],
  );
  return rows;
};

const setProjectStatus = (scope: TenantScope, projectId: string, status: string) =>
  db.withTenant(scope, (tx) =>
    tx.project.update({
      where: { id: projectId },
      data: { status: status as 'draft' },
      select: { id: true },
    }),
  );

const setWorkspaceStatus = (workspaceId: string, status: 'active' | 'suspended') =>
  adminRole.query('SELECT app.admin_set_workspace_status($1, $2, $3, $4, $5)', [
    platformAdmin,
    workspaceId,
    status,
    'S7 resolve_host test',
    'corr-s7',
  ]);

describe('app.resolve_host as app_public', () => {
  it('an active platform subdomain of a draft project resolves to the placeholder with its ids', async () => {
    expect(await resolve(A.hostname)).toEqual([
      { outcome: 'placeholder', workspace_id: A.scope.workspaceId, project_id: A.projectId },
    ]);
    await expect(visitor.resolveHost(A.hostname)).resolves.toEqual({
      outcome: 'placeholder',
      workspaceId: A.scope.workspaceId,
      projectId: A.projectId,
    });
  });

  it('matches case-insensitively and exactly (no pattern matching, no partial host names)', async () => {
    expect((await resolve(A.hostname.toUpperCase()))[0]?.outcome).toBe('placeholder');
    const [label, ...rest] = A.hostname.split('.');
    for (const probe of [
      `x${A.hostname}`,
      `${label}.`,
      rest.join('.'),
      `%.${rest.join('.')}`,
      `_${A.hostname.slice(1)}`,
      `${A.hostname}.`,
      ` ${A.hostname}`,
    ]) {
      expect([probe, await resolve(probe)]).toEqual([
        probe,
        [{ outcome: 'unknown', workspace_id: null, project_id: null }],
      ]);
    }
  });

  it('unknown, empty, NULL and over-long input give exactly one unknown row', async () => {
    for (const probe of ['nobody.sites.localhost', '', null, `${'a'.repeat(250)}.com`, "x'; SELECT 1; --"]) {
      expect(await resolve(probe)).toEqual([{ outcome: 'unknown', workspace_id: null, project_id: null }]);
    }
    await expect(visitor.resolveHost('nobody.sites.localhost')).resolves.toEqual({ outcome: 'unknown' });
  });

  it('a paused project shows maintenance; archived is unknown; restored is the placeholder again', async () => {
    const ws = await seedWorkspace(db, auth);
    for (const status of ['in_review', 'approved', 'live'])
      await setProjectStatus(ws.scope, ws.projectId, status);
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('placeholder');
    await setProjectStatus(ws.scope, ws.projectId, 'paused');
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('maintenance');
    await setProjectStatus(ws.scope, ws.projectId, 'archived');
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('unknown');
    await setProjectStatus(ws.scope, ws.projectId, 'draft');
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('placeholder');
  });

  it('a suspended workspace shows maintenance on its hosts only (FR-WS-04); unsuspending restores it', async () => {
    const ws = await seedWorkspace(db, auth);
    await setWorkspaceStatus(ws.scope.workspaceId, 'suspended');
    try {
      expect(await resolve(ws.hostname)).toEqual([
        { outcome: 'maintenance', workspace_id: ws.scope.workspaceId, project_id: ws.projectId },
      ]);
      expect((await resolve(A.hostname))[0]?.outcome).toBe('placeholder');
    } finally {
      await setWorkspaceStatus(ws.scope.workspaceId, 'active');
    }
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('placeholder');
  });

  it('a workspace scheduled for deletion shows maintenance; cancelling restores it', async () => {
    const ws = await seedWorkspace(db, auth);
    await db.withTenant(ws.scope, (tx) =>
      tx.workspace.update({
        where: { id: ws.scope.workspaceId },
        data: { deletedAt: new Date() },
        select: { id: true },
      }),
    );
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('maintenance');
    const readOnly = await db.resolveTenantScope(ws.ownerId, ws.scope.workspaceId);
    await db.withTenant(readOnly!, (tx) =>
      tx.workspace.update({
        where: { id: ws.scope.workspaceId },
        data: { deletedAt: null },
        select: { id: true },
      }),
    );
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('placeholder');
  });

  it('a soft-deleted domain no longer resolves', async () => {
    const ws = await seedWorkspace(db, auth);
    await db.withTenant(ws.scope, (tx) =>
      tx.domain.update({ where: { id: ws.domainId }, data: { deletedAt: new Date() }, select: { id: true } }),
    );
    expect((await resolve(ws.hostname))[0]?.outcome).toBe('unknown');
  });

  it('ignores any context the caller sets: the answer depends on the host name only', async () => {
    const client = await publicRole.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)",
        [B.scope.workspaceId, B.ownerId],
      );
      const { rows } = await client.query('SELECT outcome, workspace_id FROM app.resolve_host($1)', [
        A.hostname,
      ]);
      expect(rows).toEqual([{ outcome: 'placeholder', workspace_id: A.scope.workspaceId }]);
      // And the context does not open a table either.
      await expectPgError(client.query('SELECT 1 FROM app.domains LIMIT 1'), '42501');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('app_public cannot call any other function, including the allocator and the S6 readers', async () => {
    for (const sql of [
      `SELECT app.allocate_platform_subdomain('${A.projectId}', 'stolen')`,
      `SELECT app.notification_delivery('${A.projectId}')`,
      'SELECT * FROM app.outbox_pending(10, 0)',
      'SELECT app.workspace_writable()',
      'SELECT app.current_workspace()',
    ]) {
      await expectPgError(publicRole.query(sql), '42501');
    }
  });
});

describe('createPublicDatabase', () => {
  it('runs as app_public and refuses any other role URL before connecting', async () => {
    await expect(visitor.verifyRole()).resolves.toBeUndefined();
    expect(() => createPublicDatabase({ connectionString: urls.app })).toThrow(/DATABASE_URL_PUBLIC/);
    expect(() => createPublicDatabase({ connectionString: urls.migrator })).toThrow(/app_public/);
  });

  it('connecting has its own timeout (S7-10): an unreachable server fails after connectTimeoutMs, not the query timeout', async () => {
    const blackhole = createPublicDatabase({
      // TEST-NET-1 (RFC 5737): never routed, so the TCP connect hangs until the timeout.
      connectionString: 'postgresql://app_public@192.0.2.1:5432/platform?sslmode=disable',
      connectTimeoutMs: 300,
      queryTimeoutMs: 60_000,
    });
    const started = performance.now();
    try {
      await expect(blackhole.resolveHost('a.sites.localhost')).rejects.toThrow(/timeout/i);
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      await blackhole.close();
    }
  });
});
