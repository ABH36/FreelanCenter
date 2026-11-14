/**
 * P3 S1: the builder data model (migration 20261114180000). What the database guarantees on its own, whatever the
 * service does: draft revisions move by exactly one (optimistic concurrency), change sets only move forward,
 * site versions are immutable for every role, pointers stay on their project and kind, the publish policy (Q15),
 * the edit lock (approved 2026-11-14) and read-only archived projects. Cross-tenant behaviour is in the isolation
 * matrix (tests/isolation).
 */
import { createHash } from 'node:crypto';
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
let migrator: pg.Pool;
let A: SeededWorkspace;
let owner: TenantScope;
let editor: TenantScope;
let editor2: TenantScope;
let viewer: TenantScope;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const config = { schemaVersion: '1.0', pages: [] };

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  migrator = pool(urls.migrator, 1);
  A = await seedWorkspace(db, auth);
  owner = A.scope;
  const [e1, e2, v] = [await createUser(auth), await createUser(auth), await createUser(auth)];
  await db.withTenant(owner, async (tx) => {
    await tx.membership.create({ data: { workspaceId: owner.workspaceId, userId: e1, role: 'editor' } });
    await tx.membership.create({ data: { workspaceId: owner.workspaceId, userId: e2, role: 'editor' } });
    await tx.membership.create({ data: { workspaceId: owner.workspaceId, userId: v, role: 'viewer' } });
  });
  editor = (await db.resolveTenantScope(e1, owner.workspaceId))!;
  editor2 = (await db.resolveTenantScope(e2, owner.workspaceId))!;
  viewer = (await db.resolveTenantScope(v, owner.workspaceId))!;
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end(), migrator.end()]);
});

const newProject = (scope: TenantScope = owner) =>
  db.withTenant(
    scope,
    async (tx) =>
      (
        await tx.project.create({
          data: { workspaceId: scope.workspaceId, name: 'Builder', createdBy: scope.actorUserId },
          select: { id: true },
        })
      ).id,
  );
const draft = (tx: Tx, scope: TenantScope, projectId: string) =>
  tx.siteDraft.create({
    data: { workspaceId: scope.workspaceId, projectId, config, schemaVersion: '1.0' },
    select: { id: true, revision: true, createdBy: true },
  });
const version = (tx: Tx, scope: TenantScope, projectId: string, kind: 'staging' | 'live') =>
  tx.siteVersion.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId,
      kind,
      config,
      schemaVersion: '1.0',
      checksum: sha(JSON.stringify(config)),
      sourceDraftRevision: 1,
    },
    select: { id: true, createdBy: true },
  });

describe('site_drafts: revisions and authorship (FR-BLD-06)', () => {
  it('a draft starts at revision 1 whatever the client sends, with the actor as author', async () => {
    const projectId = await newProject();
    const row = await db.withTenant(editor, (tx) =>
      tx.siteDraft.create({
        data: { workspaceId: editor.workspaceId, projectId, config, schemaVersion: '1.0', revision: 99 },
        select: { revision: true, createdBy: true, updatedBy: true },
      }),
    );
    expect(row).toEqual({ revision: 1, createdBy: editor.actorUserId, updatedBy: editor.actorUserId });
  });

  it('a save with the expected revision moves it by one; a stale save matches nothing', async () => {
    const projectId = await newProject();
    const { id } = await db.withTenant(owner, (tx) => draft(tx, owner, projectId));
    const save = (scope: TenantScope, expected: number) =>
      db.withTenant(scope, (tx) =>
        tx.siteDraft.updateMany({
          where: { id, revision: expected },
          data: { config: { ...config, by: scope.actorUserId }, revision: expected + 1 },
        }),
      );
    expect((await save(editor, 1)).count).toBe(1);
    // A second editor still holding revision 1 loses: nothing is overwritten (no last-write-wins).
    expect((await save(editor2, 1)).count).toBe(0);
    const row = await db.withTenant(owner, (tx) =>
      tx.siteDraft.findUniqueOrThrow({
        where: { id },
        select: { revision: true, updatedBy: true, config: true },
      }),
    );
    expect(row).toMatchObject({
      revision: 2,
      updatedBy: editor.actorUserId,
      config: { by: editor.actorUserId },
    });
  });

  it('a revision that does not move by exactly one is refused (P5101)', async () => {
    const projectId = await newProject();
    const { id } = await db.withTenant(owner, (tx) => draft(tx, owner, projectId));
    await expectPgError(
      db.withTenant(owner, (tx) => tx.siteDraft.update({ where: { id }, data: { revision: 5 } })),
      'P5101',
    );
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.siteDraft.update({ where: { id }, data: { config: { schemaVersion: '1.0' } } }),
      ),
      'P5101',
    );
  });

  it('one draft per project; oversized or non-object configs are refused', async () => {
    const projectId = await newProject();
    await db.withTenant(owner, (tx) => draft(tx, owner, projectId));
    await expectPgError(
      db.withTenant(owner, (tx) => draft(tx, owner, projectId)),
      '23505',
    );
    const other = await newProject();
    const big = { schemaVersion: '1.0', blob: 'x'.repeat(530_000) };
    for (const bad of [big, [1, 2]]) {
      await expectPgError(
        db.withTenant(owner, (tx) =>
          tx.siteDraft.create({
            data: { workspaceId: owner.workspaceId, projectId: other, config: bad, schemaVersion: '1.0' },
          }),
        ),
        '23514',
      );
    }
  });

  it('a viewer reads drafts but cannot write them', async () => {
    const projectId = await newProject();
    const { id } = await db.withTenant(owner, (tx) => draft(tx, owner, projectId));
    expect(await db.withTenant(viewer, (tx) => tx.siteDraft.count({ where: { id } }))).toBe(1);
    await expectPgError(
      db.withTenant(viewer, (tx) => draft(tx, viewer, projectId)),
      '42501',
    );
    expect(
      (await db.withTenant(viewer, (tx) => tx.siteDraft.updateMany({ where: { id }, data: { revision: 2 } })))
        .count,
    ).toBe(0);
  });
});

describe('change_sets: forward-only history', () => {
  const proposed = (tx: Tx, scope: TenantScope, projectId: string) =>
    tx.changeSet.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId,
        source: 'ai',
        operations: [{ op: 'set', path: '/x', value: 1 }],
        baseRevision: 1,
      },
      select: { id: true, status: true, decidedBy: true, createdBy: true },
    });

  it('a proposal has no decision; accepting it records who decided, and nothing else can change', async () => {
    const projectId = await newProject();
    const cs = await db.withTenant(editor, (tx) => proposed(tx, editor, projectId));
    expect(cs).toMatchObject({ status: 'proposed', decidedBy: null, createdBy: editor.actorUserId });
    const applied = await db.withTenant(owner, (tx) =>
      tx.changeSet.update({
        where: { id: cs.id },
        data: { status: 'applied', inverse: [{ op: 'remove', path: '/x' }], resultRevision: 2 },
        select: { status: true, decidedBy: true },
      }),
    );
    expect(applied).toEqual({ status: 'applied', decidedBy: owner.actorUserId });
    // applied → proposed and applied → rejected are not moves; the inverse of an applied change is fixed.
    for (const data of [
      { status: 'proposed' },
      { status: 'rejected' },
      { inverse: [{ op: 'noop' }] },
    ] satisfies Array<Parameters<Tx['changeSet']['update']>[0]['data']>) {
      await expectPgError(
        db.withTenant(owner, (tx) => tx.changeSet.update({ where: { id: cs.id }, data })),
        'P5102',
      );
    }
    await db.withTenant(owner, (tx) =>
      tx.changeSet.update({ where: { id: cs.id }, data: { status: 'undone' } }),
    );
  });

  it('an applied change must carry its inverse and move the revision by one', async () => {
    const projectId = await newProject();
    const base = { workspaceId: owner.workspaceId, projectId, source: 'manual' as const, operations: [] };
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.changeSet.create({ data: { ...base, status: 'applied', baseRevision: 3, resultRevision: 4 } }),
      ),
      '23514',
    );
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.changeSet.create({
          data: { ...base, status: 'applied', baseRevision: 3, resultRevision: 5, inverse: [] },
        }),
      ),
      '23514',
    );
    const ok = await db.withTenant(owner, (tx) =>
      tx.changeSet.create({
        data: { ...base, status: 'applied', baseRevision: 3, resultRevision: 4, inverse: [] },
        select: { decidedBy: true },
      }),
    );
    expect(ok.decidedBy).toBe(owner.actorUserId);
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.changeSet.create({ data: { ...base, status: 'undone', baseRevision: 1 } }),
      ),
      'P5102',
    );
  });

  it('nobody deletes a change set', async () => {
    const projectId = await newProject();
    const cs = await db.withTenant(owner, (tx) => proposed(tx, owner, projectId));
    await expectPgError(
      db.withTenant(owner, (tx) => tx.changeSet.delete({ where: { id: cs.id } })),
      '42501',
    );
  });
});

describe('site_versions: immutable for every role (Q7)', () => {
  it('UPDATE, DELETE and TRUNCATE are refused for app_user and for the table owner', async () => {
    const projectId = await newProject();
    const v = await db.withTenant(owner, (tx) => version(tx, owner, projectId, 'staging'));
    expect(v.createdBy).toBe(owner.actorUserId);
    await expectPgError(
      db.withTenant(owner, (tx) => tx.siteVersion.update({ where: { id: v.id }, data: { note: 'x' } })),
      '42501',
    );
    await expectPgError(
      db.withTenant(owner, (tx) => tx.siteVersion.delete({ where: { id: v.id } })),
      '42501',
    );
    // The migrator owns the table. Under FORCE RLS it sees no row at all; TRUNCATE (a statement) is refused.
    expect(
      (await migrator.query(`UPDATE app.site_versions SET note = 'x' WHERE id = $1`, [v.id])).rowCount,
    ).toBe(0);
    await expectPgError(migrator.query('TRUNCATE app.site_versions CASCADE'), '42501');
    // Even with RLS lifted for the owner (in a transaction that is rolled back), the row triggers refuse.
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE app.site_versions NO FORCE ROW LEVEL SECURITY');
      for (const sql of [
        `UPDATE app.site_versions SET note = 'x' WHERE id = $1`,
        'DELETE FROM app.site_versions WHERE id = $1',
      ]) {
        await client.query('SAVEPOINT s');
        await expectPgError(client.query(sql, [v.id]), '42501');
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the checksum must be a SHA-256 hex digest', async () => {
    const projectId = await newProject();
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.siteVersion.create({
          data: {
            workspaceId: owner.workspaceId,
            projectId,
            kind: 'staging',
            config,
            schemaVersion: '1.0',
            checksum: 'not-a-digest',
            sourceDraftRevision: 1,
          },
        }),
      ),
      '23514',
    );
  });
});

describe('publishing policy (Q15) and pointers', () => {
  it('an editor publishes and points staging only; live is for owners and admins', async () => {
    const projectId = await newProject();
    const staging = await db.withTenant(editor, (tx) => version(tx, editor, projectId, 'staging'));
    await db.withTenant(editor, (tx) =>
      tx.sitePointer.create({
        data: { workspaceId: editor.workspaceId, projectId, kind: 'staging', siteVersionId: staging.id },
      }),
    );
    await expectPgError(
      db.withTenant(editor, (tx) => version(tx, editor, projectId, 'live')),
      '42501',
    );
    const live = await db.withTenant(owner, (tx) => version(tx, owner, projectId, 'live'));
    await expectPgError(
      db.withTenant(editor, (tx) =>
        tx.sitePointer.create({
          data: { workspaceId: editor.workspaceId, projectId, kind: 'live', siteVersionId: live.id },
        }),
      ),
      '42501',
    );
    const pointer = await db.withTenant(owner, (tx) =>
      tx.sitePointer.create({
        data: { workspaceId: owner.workspaceId, projectId, kind: 'live', siteVersionId: live.id },
        select: { id: true, updatedBy: true },
      }),
    );
    expect(pointer.updatedBy).toBe(owner.actorUserId);
    expect(
      (
        await db.withTenant(editor, (tx) =>
          tx.sitePointer.updateMany({ where: { id: pointer.id }, data: { siteVersionId: live.id } }),
        )
      ).count,
    ).toBe(0);
  });

  it('a pointer accepts only a version of its own project and kind; rollback moves it, never the version', async () => {
    const projectId = await newProject();
    const other = await newProject();
    const [v1, v2, staging, foreign] = await db.withTenant(owner, async (tx) => [
      await version(tx, owner, projectId, 'live'),
      await version(tx, owner, projectId, 'live'),
      await version(tx, owner, projectId, 'staging'),
      await version(tx, owner, other, 'live'),
    ]);
    const pointer = await db.withTenant(owner, (tx) =>
      tx.sitePointer.create({
        data: { workspaceId: owner.workspaceId, projectId, kind: 'live', siteVersionId: v2.id },
        select: { id: true },
      }),
    );
    for (const bad of [staging.id, foreign.id]) {
      await expectPgError(
        db.withTenant(owner, (tx) =>
          tx.sitePointer.update({ where: { id: pointer.id }, data: { siteVersionId: bad } }),
        ),
        'P5103',
      );
    }
    await db.withTenant(owner, (tx) =>
      tx.sitePointer.update({ where: { id: pointer.id }, data: { siteVersionId: v1.id } }),
    );
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.sitePointer.create({
          data: { workspaceId: owner.workspaceId, projectId, kind: 'live', siteVersionId: v1.id },
        }),
      ),
      '23505',
    );
  });
});

describe('project_edit_locks (FR-BLD-07; approved 2026-11-14)', () => {
  const take = (scope: TenantScope, projectId: string) =>
    db.withTenant(scope, (tx) =>
      tx.projectEditLock.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId,
          holderUserId: '01920000-0000-7000-8000-00000000f00d',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true, holderUserId: true, acquiredAt: true, heartbeatAt: true, expiresAt: true },
      }),
    );
  const renew = (scope: TenantScope, id: string) =>
    db.withTenant(scope, (tx) =>
      tx.projectEditLock.updateMany({ where: { id }, data: { holderUserId: scope.actorUserId } }),
    );

  it('the database sets the holder to the actor and a 2-minute lifetime, whatever the client sends', async () => {
    const projectId = await newProject();
    const lock = await take(editor, projectId);
    expect(lock.holderUserId).toBe(editor.actorUserId);
    expect(lock.expiresAt.getTime() - lock.heartbeatAt.getTime()).toBe(120_000);
    expect(lock.acquiredAt.getTime()).toBe(lock.heartbeatAt.getTime());
    await expectPgError(take(editor2, projectId), '23505');
  });

  it('another editor cannot take a live lock; the holder renews it and keeps acquired_at', async () => {
    const projectId = await newProject();
    const lock = await take(editor, projectId);
    expect((await renew(editor2, lock.id)).count).toBe(0);
    expect((await renew(editor, lock.id)).count).toBe(1);
    const row = await db.withTenant(viewer, (tx) =>
      tx.projectEditLock.findUniqueOrThrow({ where: { id: lock.id } }),
    );
    expect(row.holderUserId).toBe(editor.actorUserId);
    expect(row.acquiredAt.getTime()).toBe(lock.acquiredAt.getTime());
  });

  it('an owner may take a live lock over; an expired lock may be taken by any editor', async () => {
    const projectId = await newProject();
    const lock = await take(editor, projectId);
    expect((await renew(owner, lock.id)).count).toBe(1);
    const taken = await db.withTenant(owner, (tx) =>
      tx.projectEditLock.findUniqueOrThrow({ where: { id: lock.id } }),
    );
    expect(taken.holderUserId).toBe(owner.actorUserId);
    expect(taken.acquiredAt.getTime()).toBeGreaterThanOrEqual(lock.acquiredAt.getTime());
    // Expire it without waiting 2 minutes: as the table owner, in one transaction that lifts FORCE RLS and the
    // guard, moves the times back and restores both before COMMIT (DDL is transactional, so no other session ever
    // sees the table without them).
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE app.project_edit_locks NO FORCE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE app.project_edit_locks DISABLE TRIGGER project_edit_locks_guard');
      await client.query(
        `UPDATE app.project_edit_locks SET heartbeat_at = now() - interval '5 minutes',
                                           expires_at = now() - interval '3 minutes' WHERE id = $1`,
        [lock.id],
      );
      await client.query('ALTER TABLE app.project_edit_locks ENABLE TRIGGER project_edit_locks_guard');
      await client.query('ALTER TABLE app.project_edit_locks FORCE ROW LEVEL SECURITY');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect((await renew(editor2, lock.id)).count).toBe(1);
  });

  it('releasing: the holder or an owner deletes the lock; a viewer can neither take nor release it', async () => {
    const projectId = await newProject();
    await expectPgError(take(viewer, projectId), '42501');
    const lock = await take(editor, projectId);
    expect(
      (await db.withTenant(editor2, (tx) => tx.projectEditLock.deleteMany({ where: { id: lock.id } }))).count,
    ).toBe(0);
    expect(
      (await db.withTenant(viewer, (tx) => tx.projectEditLock.deleteMany({ where: { id: lock.id } }))).count,
    ).toBe(0);
    expect(
      (await db.withTenant(editor, (tx) => tx.projectEditLock.deleteMany({ where: { id: lock.id } }))).count,
    ).toBe(1);
  });
});

describe('an archived project is read-only for builder data', () => {
  it('no new draft, change, version or lock while archived; writes resume after restoring', async () => {
    const projectId = await newProject();
    const { id: draftId } = await db.withTenant(owner, (tx) => draft(tx, owner, projectId));
    const setStatus = (status: 'archived' | 'draft') =>
      db.withTenant(owner, (tx) => tx.project.update({ where: { id: projectId }, data: { status } }));
    await setStatus('archived');
    expect(
      (
        await db.withTenant(owner, (tx) =>
          tx.siteDraft.updateMany({ where: { id: draftId, revision: 1 }, data: { revision: 2 } }),
        )
      ).count,
    ).toBe(0);
    await expectPgError(
      db.withTenant(owner, (tx) => version(tx, owner, projectId, 'staging')),
      '42501',
    );
    await expectPgError(
      db.withTenant(owner, (tx) =>
        tx.changeSet.create({
          data: {
            workspaceId: owner.workspaceId,
            projectId,
            source: 'manual',
            operations: [],
            baseRevision: 1,
          },
        }),
      ),
      '42501',
    );
    await setStatus('draft');
    expect(
      (
        await db.withTenant(owner, (tx) =>
          tx.siteDraft.updateMany({ where: { id: draftId, revision: 1 }, data: { revision: 2 } }),
        )
      ).count,
    ).toBe(1);
  });
});
