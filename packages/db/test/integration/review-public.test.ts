/**
 * P3 S8a: client review through the real app_public client (`@platform/db/public`): add_review_comment (pin check,
 * bounds, stale version, link states, the 300 cap), approve_review_version (once per link and version, audit row),
 * get_review_thread / get_review_approval (what a link may show), and the member side under RLS: replies take
 * their pin from the client comment, only owners/admins/editors reply and resolve, approvals and comments are never
 * changed or deleted, and app_user cannot write a client comment.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../../src/client';
import { type PublicDatabase, createPublicDatabase } from '../../src/public';
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
let admin: pg.Pool;
let visitor: PublicDatabase;
let A: SeededWorkspace;
let B: SeededWorkspace;
let link: string;
let version: string;
let editorId: string;
let viewerId: string;

const DAY = 86_400_000;
const CONFIG = {
  schemaVersion: '1.0',
  pages: [
    { id: 'home', path: '/', sections: [{ id: 'hero-1' }, { id: 'services-1' }] },
    { id: 'about', path: '/about', sections: [{ id: 'about-1' }] },
  ],
};
const IP = 'a'.repeat(32);

const comment = (over: Partial<Parameters<PublicDatabase['addReviewComment']>[0]> = {}) =>
  visitor.addReviewComment({
    linkId: link,
    versionId: version,
    pageId: 'home',
    sectionId: 'hero-1',
    name: 'Ramesh',
    email: null,
    body: 'Please make the phone number bigger.',
    ipHash: IP,
    ...over,
  });

/** A new staging version of A's project with CONFIG, moved onto the staging pointer. */
async function newStaging(): Promise<string> {
  return db.withTenant(A.scope, async (tx) => {
    const v = await tx.siteVersion.create({
      data: {
        workspaceId: A.scope.workspaceId,
        projectId: A.projectId,
        kind: 'staging',
        config: CONFIG,
        schemaVersion: '1.0',
        checksum: uuidv7().replace(/-/g, '').padEnd(64, '0'),
        sourceDraftRevision: 1,
      },
      select: { id: true },
    });
    await tx.sitePointer.update({
      where: {
        workspaceId_projectId_kind: {
          workspaceId: A.scope.workspaceId,
          projectId: A.projectId,
          kind: 'staging',
        },
      },
      data: { siteVersionId: v.id },
    });
    return v.id;
  });
}

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  admin = pool(urls.bootstrap, 2);
  visitor = createPublicDatabase({ connectionString: urls.public });
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
  editorId = await createUser(auth);
  viewerId = await createUser(auth);
  await db.withTenant(A.scope, async (tx) => {
    await tx.membership.create({
      data: { workspaceId: A.scope.workspaceId, userId: editorId, role: 'editor' },
    });
    await tx.membership.create({
      data: { workspaceId: A.scope.workspaceId, userId: viewerId, role: 'viewer' },
    });
  });
  version = await newStaging();
  link = await db.withTenant(A.scope, async (tx) => {
    const l = await tx.stagingLink.create({
      data: {
        workspaceId: A.scope.workspaceId,
        projectId: A.projectId,
        expiresAt: new Date(Date.now() + DAY),
      },
      select: { id: true },
    });
    return l.id;
  });
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end(), admin.end(), visitor.close()]);
});

describe('add_review_comment', () => {
  it('records a pinned client comment and shows it in the thread without e-mail or IP', async () => {
    expect(await comment({ email: '  Ramesh@Example.TEST ' })).toBe('ok');
    expect(await comment({ pageId: 'about', sectionId: null, body: 'About page is fine.' })).toBe('ok');
    expect(await comment({ pageId: null, sectionId: null, body: '  Whole site looks good  ' })).toBe('ok');

    const thread = await visitor.getReviewThread(link, version);
    expect(thread.map((t) => [t.pageId, t.sectionId, t.body, t.authorKind, t.authorName])).toEqual([
      ['home', 'hero-1', 'Please make the phone number bigger.', 'client', 'Ramesh'],
      ['about', null, 'About page is fine.', 'client', 'Ramesh'],
      [null, null, 'Whole site looks good', 'client', 'Ramesh'],
    ]);
    expect(thread.every((t) => t.parentId === null && t.resolved === false)).toBe(true);
    expect(Object.keys(thread[0] ?? {})).not.toContain('email');

    const stored = await db.withTenant(A.scope, (tx) =>
      tx.reviewComment.findFirstOrThrow({
        where: { stagingLinkId: link, sectionId: 'hero-1' },
        select: { authorEmail: true, ipHash: true, authorUserId: true, workspaceId: true, projectId: true },
      }),
    );
    expect(stored).toEqual({
      authorEmail: 'ramesh@example.test',
      ipHash: IP,
      authorUserId: null,
      workspaceId: A.scope.workspaceId,
      projectId: A.projectId,
    });
  });

  it('refuses a page or section the version does not have, and out-of-bounds input', async () => {
    expect(await comment({ sectionId: 'missing' })).toBe('no_section');
    expect(await comment({ pageId: 'nope', sectionId: null })).toBe('no_section');
    expect(await comment({ pageId: 'about', sectionId: 'hero-1' })).toBe('no_section');
    expect(await comment({ pageId: null, sectionId: 'hero-1' })).toBe('invalid');
    expect(await comment({ name: '   ' })).toBe('invalid');
    expect(await comment({ name: 'x'.repeat(81) })).toBe('invalid');
    expect(await comment({ body: '' })).toBe('invalid');
    expect(await comment({ body: 'x'.repeat(2001) })).toBe('invalid');
    expect(await comment({ email: 'not-an-email' })).toBe('invalid');
    expect(await comment({ ipHash: 'zz' })).toBe('invalid');
  });

  it('refuses a version the link no longer shows, and links that may not show', async () => {
    expect(await comment({ versionId: A.projectId })).toBe('stale');
    expect(await comment({ linkId: uuidv7() })).toBe('unknown');
    const [expired, revoked] = await db.withTenant(A.scope, async (tx) => {
      const now = Date.now();
      const e = await tx.stagingLink.create({
        data: {
          workspaceId: A.scope.workspaceId,
          projectId: A.projectId,
          createdAt: new Date(now - 2 * DAY),
          expiresAt: new Date(now - DAY),
        },
      });
      const r = await tx.stagingLink.create({
        data: { workspaceId: A.scope.workspaceId, projectId: A.projectId, expiresAt: new Date(now + DAY) },
      });
      await tx.stagingLink.update({
        where: { id: r.id },
        data: { revokedAt: new Date(), revokedBy: A.ownerId },
      });
      return [e.id, r.id];
    });
    expect(await comment({ linkId: expired })).toBe('expired');
    expect(await comment({ linkId: revoked })).toBe('revoked');
    expect(await visitor.getReviewThread(revoked, version)).toEqual([]);
    expect(
      await visitor.approveReviewVersion({
        linkId: revoked,
        versionId: version,
        name: 'R',
        email: null,
        ipHash: null,
      }),
    ).toBe('revoked');
  });

  it("never reaches another workspace's version through a link", async () => {
    const other = await db.withTenant(B.scope, (tx) =>
      tx.sitePointer.findFirstOrThrow({ where: { kind: 'staging' }, select: { siteVersionId: true } }),
    );
    expect(await comment({ versionId: other.siteVersionId, pageId: null, sectionId: null })).toBe('stale');
    expect(await visitor.getReviewThread(link, other.siteVersionId)).toEqual([]);
  });
});

describe('member replies and resolution (RLS)', () => {
  it('a reply takes the pin of its client comment, is shown to the client, and editors may resolve', async () => {
    const parent = await db.withTenant(A.scope, (tx) =>
      tx.reviewComment.findFirstOrThrow({ where: { stagingLinkId: link, sectionId: 'hero-1' } }),
    );
    const editor = { ...A.scope, actorUserId: editorId, role: 'editor' as const };
    const reply = await db.withTenant(editor, (tx) =>
      tx.reviewComment.create({
        data: {
          workspaceId: A.scope.workspaceId,
          // Lies about everything the database takes from the parent.
          projectId: A.projectId,
          siteVersionId: version,
          stagingLinkId: link,
          pageId: 'about',
          sectionId: 'about-1',
          authorKind: 'member',
          body: 'Done, the number is bigger now.',
          parentId: parent.id,
        },
      }),
    );
    expect(reply).toMatchObject({
      pageId: 'home',
      sectionId: 'hero-1',
      authorUserId: editorId,
      authorName: null,
    });

    const thread = await visitor.getReviewThread(link, version);
    const shown = thread.find((t) => t.id === reply.id);
    expect(shown).toMatchObject({ parentId: parent.id, authorKind: 'member', authorName: null });

    const resolved = await db.withTenant(editor, (tx) =>
      tx.reviewComment.update({
        where: { id: parent.id },
        data: { resolvedAt: new Date(0), resolvedBy: A.ownerId },
      }),
    );
    // The database stamps who and when, not the caller.
    expect(resolved.resolvedBy).toBe(editorId);
    expect(resolved.resolvedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await visitor.getReviewThread(link, version)).find((t) => t.id === parent.id)?.resolved).toBe(
      true,
    );
    const reopened = await db.withTenant(editor, (tx) =>
      tx.reviewComment.update({ where: { id: parent.id }, data: { resolvedAt: null, resolvedBy: null } }),
    );
    expect([reopened.resolvedAt, reopened.resolvedBy]).toEqual([null, null]);
  });

  it('a reply to a reply, a viewer reply, a member "client" comment and edits are refused', async () => {
    const reply = await db.withTenant(A.scope, (tx) =>
      tx.reviewComment.findFirstOrThrow({ where: { stagingLinkId: link, authorKind: 'member' } }),
    );
    const base = {
      workspaceId: A.scope.workspaceId,
      projectId: A.projectId,
      siteVersionId: version,
      stagingLinkId: link,
      body: 'x',
    };
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.reviewComment.create({ data: { ...base, authorKind: 'member', parentId: reply.id } }),
      ),
      'P5103',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.reviewComment.create({ data: { ...base, authorKind: 'member', parentId: uuidv7() } }),
      ),
      'P5103',
    );
    await expectPgError(
      db.withTenant({ ...A.scope, actorUserId: viewerId, role: 'viewer' }, (tx) =>
        tx.reviewComment.create({ data: { ...base, authorKind: 'member', parentId: reply.parentId } }),
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) =>
          tx.$executeRaw`INSERT INTO app.review_comments (workspace_id, project_id, site_version_id, staging_link_id,
                         author_kind, author_name, body)
                       VALUES (${A.scope.workspaceId}::uuid, ${A.projectId}::uuid, ${version}::uuid, ${link}::uuid,
                               'client', 'Fake client', 'x')`,
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.reviewComment.update({ where: { id: reply.id }, data: { body: 'edited' } }),
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) => tx.reviewComment.delete({ where: { id: reply.id } })),
      '42501',
    );
    // A viewer's UPDATE matches no row (the policy's USING hides it): nothing changes.
    const changed = await db.withTenant({ ...A.scope, actorUserId: viewerId, role: 'viewer' }, (tx) =>
      tx.reviewComment.updateMany({ where: { id: reply.parentId ?? '' }, data: { resolvedAt: new Date() } }),
    );
    expect(changed.count).toBe(0);
  });

  it("another workspace sees none of A's comments or approvals", async () => {
    const seen = await db.withTenant(B.scope, async (tx) => ({
      comments: await tx.reviewComment.count({ where: { workspaceId: A.scope.workspaceId } }),
      approvals: await tx.reviewApproval.count({ where: { workspaceId: A.scope.workspaceId } }),
    }));
    expect(seen).toEqual({ comments: 0, approvals: 0 });
  });
});

describe('approve_review_version', () => {
  it('records one approval per link and version with a client audit row, then answers already', async () => {
    expect(await visitor.getReviewApproval(link, version)).toBeNull();
    const approve = (name = 'Ramesh Sharma') =>
      visitor.approveReviewVersion({
        linkId: link,
        versionId: version,
        name,
        email: 'r@example.test',
        ipHash: IP,
      });
    expect(await approve()).toBe('ok');
    expect(await approve('Someone else')).toBe('already');
    const shown = await visitor.getReviewApproval(link, version);
    expect(shown?.name).toBe('Ramesh Sharma');
    expect(shown?.approvedAt).toBeInstanceOf(Date);

    const { approvals, audit, number } = await db.withTenant(A.scope, async (tx) => ({
      approvals: await tx.reviewApproval.findMany({ where: { siteVersionId: version } }),
      audit: await tx.auditLog.findMany({ where: { action: 'review.version_approved', targetId: version } }),
      number: (await tx.siteVersion.findUniqueOrThrow({ where: { id: version }, select: { number: true } }))
        .number,
    }));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approverName: 'Ramesh Sharma',
      approverEmail: 'r@example.test',
      ipHash: IP,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'client',
      actorId: null,
      projectId: A.projectId,
      result: 'success',
    });
    expect(audit[0]?.metadata).toEqual({ approvalId: approvals[0]?.id, stagingLinkId: link, number });

    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) =>
          tx.$executeRaw`UPDATE app.review_approvals SET approver_name = 'x' WHERE id = ${approvals[0]?.id}::uuid`,
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(
        A.scope,
        (tx) => tx.$executeRaw`DELETE FROM app.review_approvals WHERE id = ${approvals[0]?.id}::uuid`,
      ),
      '42501',
    );
  });

  it('a new staging version needs its own approval; the old one is stale', async () => {
    const old = version;
    const next = await newStaging();
    expect(
      await visitor.approveReviewVersion({
        linkId: link,
        versionId: old,
        name: 'R',
        email: null,
        ipHash: null,
      }),
    ).toBe('stale');
    expect(await visitor.getReviewApproval(link, next)).toBeNull();
    expect(await visitor.getReviewThread(link, next)).toEqual([]);
    version = next;
  });
});

describe('the 300-comment cap', () => {
  it('a version takes at most 300 client comments, also under concurrent posts', async () => {
    const existing = await db.withTenant(A.scope, (tx) =>
      tx.reviewComment.count({ where: { siteVersionId: version, authorKind: 'client' } }),
    );
    const results: string[] = [];
    for (let i = existing; i < 290; i++) results.push(await comment({ body: `c${i}` }));
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => comment({ body: `b${i}` })));
    expect(results.every((r) => r === 'ok')).toBe(true);
    expect(burst.filter((r) => r === 'ok')).toHaveLength(10);
    expect(burst.filter((r) => r === 'limit')).toHaveLength(10);
    const total = await db.withTenant(A.scope, (tx) =>
      tx.reviewComment.count({ where: { siteVersionId: version, authorKind: 'client' } }),
    );
    expect(total).toBe(300);
  });
});
