/**
 * P3 S6: the asset library table (migration 20261115180000; FR-BLD-05, SEC-08). What the database guarantees on its
 * own, whatever the service does: an asset starts pending and is processed once, what was uploaded never changes,
 * hiding is one-way, the actor and time columns are the database's, the 200-image cap holds under concurrency, and
 * viewers and archived projects are read-only. Cross-tenant behaviour is in the isolation matrix (tests/isolation).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { TenantDatabase, TenantScope, Tx } from '../../src/client';
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
let A: SeededWorkspace;
let owner: TenantScope;
let editor: TenantScope;
let viewer: TenantScope;

const token = () => randomBytes(16).toString('base64url');

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  A = await seedWorkspace(db, auth);
  owner = A.scope;
  const [e, v] = [await createUser(auth), await createUser(auth)];
  await db.withTenant(owner, async (tx) => {
    await tx.membership.create({ data: { workspaceId: owner.workspaceId, userId: e, role: 'editor' } });
    await tx.membership.create({ data: { workspaceId: owner.workspaceId, userId: v, role: 'viewer' } });
  });
  editor = (await db.resolveTenantScope(e, owner.workspaceId))!;
  viewer = (await db.resolveTenantScope(v, owner.workspaceId))!;
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end()]);
});

const newProject = () =>
  db.withTenant(
    owner,
    async (tx) =>
      (
        await tx.project.create({
          data: { workspaceId: owner.workspaceId, name: 'Assets', createdBy: owner.actorUserId },
          select: { id: true },
        })
      ).id,
  );

const insert = (tx: Tx, scope: TenantScope, projectId: string, extra: Record<string, unknown> = {}) =>
  tx.asset.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId,
      fileName: 'shop.jpg',
      declaredType: 'image/jpeg',
      declaredBytes: 1000,
      storageToken: token(),
      ...extra,
    },
    select: { id: true, status: true, createdBy: true, finalizedAt: true },
  });

const ready = {
  status: 'ready',
  width: 1200,
  height: 800,
  variantWidths: [400, 800, 1200],
  variantBytes: 9000,
} as const;

describe('assets: lifecycle (FR-BLD-05)', () => {
  it('an asset starts pending with the actor as author, whatever the client sends', async () => {
    const projectId = await newProject();
    const row = await db.withTenant(editor, (tx) => insert(tx, editor, projectId));
    expect(row).toMatchObject({ status: 'pending', createdBy: editor.actorUserId, finalizedAt: null });
    await expectPgError(
      db.withTenant(editor, (tx) => insert(tx, editor, projectId, { status: 'ready' })),
      'P5102',
    );
  });

  it('pending moves once to ready (with variants) or rejected (with a reason); the database stamps the time', async () => {
    const projectId = await newProject();
    const a = await db.withTenant(editor, (tx) => insert(tx, editor, projectId));
    const done = await db.withTenant(editor, (tx) =>
      tx.asset.update({ where: { id: a.id }, data: ready, select: { status: true, finalizedAt: true } }),
    );
    expect(done.status).toBe('ready');
    expect(done.finalizedAt).toBeInstanceOf(Date);
    // Processed once: no second outcome, no new variants.
    await expectPgError(
      db.withTenant(editor, (tx) =>
        tx.asset.update({ where: { id: a.id }, data: { status: 'rejected', rejectReason: 'x' } }),
      ),
      'P5102',
    );
    await expectPgError(
      db.withTenant(editor, (tx) => tx.asset.update({ where: { id: a.id }, data: { width: 10 } })),
      '42501',
    );
    const b = await db.withTenant(editor, (tx) => insert(tx, editor, projectId));
    await db.withTenant(editor, (tx) =>
      tx.asset.update({ where: { id: b.id }, data: { status: 'rejected', rejectReason: 'not_an_image' } }),
    );
    await expectPgError(
      db.withTenant(editor, (tx) => tx.asset.update({ where: { id: b.id }, data: ready })),
      'P5102',
    );
  });

  it('shape rules: a ready asset needs fixed widths; types, sizes, tokens and names are checked', async () => {
    const projectId = await newProject();
    const a = await db.withTenant(editor, (tx) => insert(tx, editor, projectId));
    for (const bad of [
      { ...ready, variantWidths: [500] },
      { ...ready, variantWidths: [] },
      { ...ready, width: null },
      { status: 'rejected' as const },
    ]) {
      await expectPgError(
        db.withTenant(editor, (tx) => tx.asset.update({ where: { id: a.id }, data: bad })),
        '23514',
      );
    }
    for (const extra of [
      { declaredType: 'image/svg+xml' },
      { declaredType: 'image/heic' },
      { declaredBytes: 10_485_761 },
      { declaredBytes: 0 },
      { storageToken: '../../etc/passwd' },
      { fileName: '' },
      { alt: 'x'.repeat(251) },
    ]) {
      await expectPgError(
        db.withTenant(editor, (tx) => insert(tx, editor, projectId, extra)),
        '23514',
      );
    }
  });

  it('what was uploaded never changes; alt text does; hiding is one-way and stamped by the database', async () => {
    const projectId = await newProject();
    const a = await db.withTenant(editor, (tx) => insert(tx, editor, projectId));
    await db.withTenant(editor, (tx) => tx.asset.update({ where: { id: a.id }, data: ready }));
    // Not in the UPDATE grant: refused before the trigger.
    await expectPgError(
      db.withTenant(editor, (tx) =>
        tx.asset.update({ where: { id: a.id }, data: { storageToken: token() } }),
      ),
      '42501',
    );
    const described = await db.withTenant(editor, (tx) =>
      tx.asset.update({ where: { id: a.id }, data: { alt: 'Front of the shop' }, select: { alt: true } }),
    );
    expect(described.alt).toBe('Front of the shop');
    const hidden = await db.withTenant(editor, (tx) =>
      tx.asset.update({
        where: { id: a.id },
        data: { deletedAt: new Date('2000-01-01') },
        select: { deletedAt: true, deletedBy: true },
      }),
    );
    expect(hidden.deletedBy).toBe(editor.actorUserId);
    expect(hidden.deletedAt!.getFullYear()).toBeGreaterThan(2000);
    await expectPgError(
      db.withTenant(owner, (tx) => tx.asset.update({ where: { id: a.id }, data: { deletedAt: null } })),
      'P5102',
    );
    // No DELETE grant for anyone: the row is the record of the upload.
    await expectPgError(
      db.withTenant(owner, (tx) => tx.asset.delete({ where: { id: a.id } })),
      '42501',
    );
  });
});

describe('assets: roles, archived projects and the image cap', () => {
  it('a viewer reads the library but cannot upload or change it', async () => {
    const projectId = await newProject();
    const a = await db.withTenant(editor, (tx) => insert(tx, editor, projectId));
    expect(await db.withTenant(viewer, (tx) => tx.asset.count({ where: { id: a.id } }))).toBe(1);
    await expectPgError(
      db.withTenant(viewer, (tx) => insert(tx, viewer, projectId)),
      '42501',
    );
    expect(
      (await db.withTenant(viewer, (tx) => tx.asset.updateMany({ where: { id: a.id }, data: { alt: 'x' } })))
        .count,
    ).toBe(0);
  });

  it('an archived project takes no uploads; they resume after restoring', async () => {
    const projectId = await newProject();
    const setStatus = (status: 'archived' | 'draft') =>
      db.withTenant(owner, (tx) => tx.project.update({ where: { id: projectId }, data: { status } }));
    await setStatus('archived');
    await expectPgError(
      db.withTenant(owner, (tx) => insert(tx, owner, projectId)),
      '42501',
    );
    await setStatus('draft');
    await db.withTenant(owner, (tx) => insert(tx, owner, projectId));
  });

  it('a project holds at most 200 images, also when uploads start at the same moment (P5104)', async () => {
    const projectId = await newProject();
    await db.withTenant(owner, async (tx) => {
      for (let i = 0; i < 198; i++) await insert(tx, owner, projectId);
    });
    // Five concurrent uploads for the last two places: the advisory lock serialises the count.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => db.withTenant(owner, (tx) => insert(tx, owner, projectId))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      await expectPgError(Promise.reject((r as PromiseRejectedResult).reason), 'P5104');
    }
    // Rejected and hidden images free their place.
    const one = await db.withTenant(owner, (tx) =>
      tx.asset.findFirstOrThrow({ where: { projectId }, select: { id: true } }),
    );
    await db.withTenant(owner, (tx) =>
      tx.asset.update({ where: { id: one.id }, data: { status: 'rejected', rejectReason: 'not_an_image' } }),
    );
    await db.withTenant(owner, (tx) => insert(tx, owner, projectId));
  });
});
