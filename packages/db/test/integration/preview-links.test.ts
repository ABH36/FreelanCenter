/**
 * P2 S8b: revocable preview links (FR-TPL-09). Real roles through the pooler. Table-level isolation between tenants
 * is the isolation suite's job (tests/isolation); this file covers what is specific to preview links: who may write
 * what, one-way revocation, no delete, and the visitor function.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantDatabase, TenantScope } from '../../src/client';
import { uuidv7 } from '../../src/uuid';
import {
  createUser,
  expectPgError,
  pool,
  seedWorkspace,
  tenantDb,
  uniqueSlug,
  urls,
  type SeededWorkspace,
} from './helpers';

let db: TenantDatabase;
let auth: pg.Pool;
let migrator: pg.Pool;
let visitor: pg.Pool;
let A: SeededWorkspace;
let B: SeededWorkspace;
let editor: TenantScope;
let viewer: TenantScope;
let templateId: string;

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  migrator = pool(urls.migrator, 2);
  visitor = pool(urls.public, 2);
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
  const editorId = await createUser(auth);
  const viewerId = await createUser(auth);
  await db.withTenant(A.scope, async (tx) => {
    await tx.membership.create({
      data: { workspaceId: A.scope.workspaceId, userId: editorId, role: 'editor' },
    });
    await tx.membership.create({
      data: { workspaceId: A.scope.workspaceId, userId: viewerId, role: 'viewer' },
    });
  });
  editor = (await db.resolveTenantScope(editorId, A.scope.workspaceId))!;
  viewer = (await db.resolveTenantScope(viewerId, A.scope.workspaceId))!;
  const { rows } = await migrator.query<{ template_id: string }>(
    `SELECT template_id FROM app.operator_publish_builtin_template($1, 'Link Test', 'gym', 'For preview link tests.', '1.0', '{"schemaVersion":"1.0"}'::jsonb, '{"fields":[]}'::jsonb, $2)`,
    [uniqueSlug('lnk').slice(0, 40), 'a'.repeat(64)],
  );
  templateId = rows[0]!.template_id;
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end(), migrator.end(), visitor.end()]);
});

const make = (scope: TenantScope, days = 7) =>
  db.withTenant(scope, async (tx) => {
    const now = new Date();
    const id = uuidv7();
    await tx.templatePreviewLink.create({
      data: {
        id,
        workspaceId: scope.workspaceId,
        templateId,
        createdBy: scope.actorUserId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + days * 86_400_000),
      },
      select: { id: true },
    });
    return id;
  });
const revokedForVisitor = async (id: string) =>
  (await visitor.query<{ r: boolean }>('SELECT app.is_preview_link_revoked($1::uuid) AS r', [id])).rows[0]!.r;

describe('who may create and revoke', () => {
  it('an editor creates a link; the owner of the workspace reads it; another workspace does not', async () => {
    const id = await make(editor);
    const own = await db.withTenant(A.scope, (tx) => tx.templatePreviewLink.findMany({ where: { id } }));
    expect(own).toHaveLength(1);
    expect(own[0]!.revokedAt).toBeNull();
    const other = await db.withTenant(B.scope, (tx) => tx.templatePreviewLink.findMany({ where: { id } }));
    expect(other).toEqual([]);
  });

  it('a viewer cannot create a link (row-level security, 42501)', async () => {
    await expectPgError(make(viewer), '42501');
  });

  it('a link cannot be created for another workspace (42501), with a forged workspace id', async () => {
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.templatePreviewLink.create({
          data: {
            workspaceId: B.scope.workspaceId,
            templateId,
            createdBy: A.scope.actorUserId,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
      ),
      '42501',
    );
  });

  it('the lifetime is bounded: not in the past, not beyond 30 days (23514)', async () => {
    const insert = (expiresAt: Date) =>
      db.withTenant(A.scope, (tx) =>
        tx.templatePreviewLink.create({
          data: { workspaceId: A.scope.workspaceId, templateId, createdBy: A.scope.actorUserId, expiresAt },
        }),
      );
    await expectPgError(insert(new Date(Date.now() - 60_000)), '23514');
    await expectPgError(insert(new Date(Date.now() + 31 * 86_400_000)), '23514');
  });
});

describe('revocation is one way', () => {
  it('an editor revokes; the visitor function then says so', async () => {
    const id = await make(A.scope);
    expect(await revokedForVisitor(id)).toBe(false);
    await db.withTenant(editor, (tx) =>
      tx.templatePreviewLink.update({
        where: { id },
        data: { revokedAt: new Date(), revokedBy: editor.actorUserId },
      }),
    );
    expect(await revokedForVisitor(id)).toBe(true);
  });

  it('a viewer cannot revoke: the link stays active', async () => {
    const id = await make(A.scope);
    await expect(
      db.withTenant(viewer, (tx) =>
        tx.templatePreviewLink.update({
          where: { id },
          data: { revokedAt: new Date(), revokedBy: viewer.actorUserId },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await revokedForVisitor(id)).toBe(false);
  });

  it('another workspace cannot revoke it', async () => {
    const id = await make(A.scope);
    await expect(
      db.withTenant(B.scope, (tx) =>
        tx.templatePreviewLink.update({
          where: { id },
          data: { revokedAt: new Date(), revokedBy: B.scope.actorUserId },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await revokedForVisitor(id)).toBe(false);
  });

  it('once revoked it cannot change again: no un-revoking, no re-attribution (42501)', async () => {
    const id = await make(A.scope);
    const revoke = (data: { revokedAt: Date | null; revokedBy: string | null }) =>
      db.withTenant(A.scope, (tx) => tx.templatePreviewLink.update({ where: { id }, data }));
    await revoke({ revokedAt: new Date(), revokedBy: A.scope.actorUserId });
    await expectPgError(revoke({ revokedAt: null, revokedBy: null }), '42501');
    await expectPgError(revoke({ revokedAt: new Date(), revokedBy: editor.actorUserId }), '42501');
    expect(await revokedForVisitor(id)).toBe(true);
  });

  it('the revocation columns come as a pair (23514)', async () => {
    const id = await make(A.scope);
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.templatePreviewLink.update({ where: { id }, data: { revokedAt: new Date() } }),
      ),
      '23514',
    );
  });

  it('nothing but the revocation can be changed by a tenant (column privileges, 42501)', async () => {
    const id = await make(A.scope);
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.templatePreviewLink.update({
          where: { id },
          data: { expiresAt: new Date(Date.now() + 20 * 86_400_000) },
        }),
      ),
      '42501',
    );
  });

  it('app_user cannot delete a link (no DELETE privilege, 42501)', async () => {
    const id = await make(A.scope);
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) => tx.$executeRaw`DELETE FROM app.template_preview_links WHERE id = ${id}::uuid`,
      ),
      '42501',
    );
  });

  it('nobody truncates the table, the owner role included (trigger, 42501)', async () => {
    await expectPgError(migrator.query('TRUNCATE app.template_preview_links'), '42501');
  });
});

describe('the visitor role (app_public)', () => {
  it('has no table privilege, only the function', async () => {
    await expectPgError(visitor.query('SELECT * FROM app.template_preview_links'), '42501');
    await expectPgError(visitor.query('SELECT id, revoked_at FROM app.template_preview_links'), '42501');
    await expectPgError(visitor.query('UPDATE app.template_preview_links SET revoked_at = now()'), '42501');
  });

  it('an unknown id is not revoked; the function is a boolean SECURITY DEFINER', async () => {
    expect(await revokedForVisitor(uuidv7())).toBe(false);
    const { rows } = await visitor.query(
      `SELECT pg_get_function_result(p.oid) AS result, p.prosecdef FROM pg_proc p WHERE p.proname = 'is_preview_link_revoked'`,
    );
    expect(rows[0]).toMatchObject({ result: 'boolean', prosecdef: true });
  });

  it('app_user cannot call it (EXECUTE is granted to app_public only)', async () => {
    const app = pool(urls.app, 1);
    try {
      await expectPgError(app.query('SELECT app.is_preview_link_revoked($1::uuid)', [uuidv7()]), '42501');
    } finally {
      await app.end();
    }
  });
});

describe('who a link was made for (P2 S10)', () => {
  const makeFor = (prospectName: string | null, prospectCity: string | null) =>
    db.withTenant(A.scope, async (tx) => {
      const id = uuidv7();
      await tx.templatePreviewLink.create({
        data: {
          id,
          workspaceId: A.scope.workspaceId,
          templateId,
          createdBy: A.scope.actorUserId,
          personalised: prospectName !== null,
          prospectName,
          prospectCity,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      });
      return id;
    });

  it('stores the prospect name and city, bounded and without markup (23514)', async () => {
    const id = await makeFor('City Cabs Indore', 'Indore');
    const row = await db.withTenant(A.scope, (tx) => tx.templatePreviewLink.findFirst({ where: { id } }));
    expect(row).toMatchObject({ prospectName: 'City Cabs Indore', prospectCity: 'Indore' });
    await expectPgError(makeFor('x'.repeat(61), null), '23514');
    await expectPgError(makeFor('<b>x</b>', null), '23514');
    await expectPgError(makeFor(null, 'y'.repeat(41)), '23514');
  });

  it('cannot be changed afterwards, not even by the link owner (42501)', async () => {
    const id = await makeFor('Sharma Fitness', 'Pune');
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.templatePreviewLink.update({ where: { id }, data: { prospectName: 'Other' } }),
      ),
      '42501',
    );
  });

  it('another workspace never sees it', async () => {
    const id = await makeFor('Private Prospect', 'Indore');
    expect(await db.withTenant(B.scope, (tx) => tx.templatePreviewLink.findMany({ where: { id } }))).toEqual(
      [],
    );
  });
});

describe('who sent a link (P2 S10, acceptance C-25)', () => {
  it('the visitor role gets the workspace name for a link, and nothing for an unknown id', async () => {
    const id = await make(A.scope);
    const { rows } = await visitor.query<{ name: string | null }>(
      'SELECT app.preview_link_sender($1::uuid) AS name',
      [id],
    );
    const own = await db.withTenant(A.scope, (tx) => tx.workspace.findFirst({ select: { name: true } }));
    expect(rows[0]!.name).toBe(own!.name);
    const none = await visitor.query<{ name: string | null }>(
      'SELECT app.preview_link_sender($1::uuid) AS name',
      [uuidv7()],
    );
    expect(none.rows[0]!.name).toBeNull();
  });
  it('app_user cannot call it (EXECUTE is granted to app_public only)', async () => {
    const app = pool(urls.app, 1);
    try {
      await expectPgError(app.query('SELECT app.preview_link_sender($1::uuid)', [uuidv7()]), '42501');
    } finally {
      await app.end();
    }
  });
});
