/**
 * P3 S8a: client review, end to end against the local database (FR-PUB-05; plan approved 2026-11-16). A real
 * staging publish and review link; the client comments and approves through the app_public functions (what
 * apps/sites calls); members read the feedback, reply (shown back to the client) and mark comments done.
 * Roles: viewers read, editors and up reply and resolve; another workspace sees nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from '@platform/db';
import { createPublicDatabase } from '@platform/db/public';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { createBuilderService } from '../../src/builder';
import { WorkspaceError } from '../../src/errors';
import { createPublishingService } from '../../src/publishing';
import { createReviewService } from '../../src/review';
import { closeAll, db, outbox, projects, unique, workspaceWith } from '../harness';

const SECRET = 'review-suite-secret-0123456789-abcdefghij';
const builder = createBuilderService({ db });
const publishing = createPublishingService({
  db,
  outbox,
  staging: { host: 'preview.sites.localhost', secret: SECRET },
});
const review = createReviewService({ db });
const visitor = createPublicDatabase({ connectionString: LOCAL_DATABASE_URLS.public });
let migrator: pg.Pool;
let templateId: string;

const config = {
  schemaVersion: '1.0',
  business: { name: 'Sharma Taxi', category: 'taxi', phone: '+919811111111' },
  theme: {
    colors: {
      primary: '#E11D2E',
      secondary: '#111827',
      accent: '#FACC15',
      background: '#0B0B0F',
      surface: '#15151C',
      text: '#F9FAFB',
    },
    typography: { heading: 'Poppins', body: 'Inter', scale: 'comfortable' },
    radius: 'lg',
    spacing: 'regular',
    buttons: { style: 'solid', shape: 'pill', hover: 'lift' },
    motion: { preset: 'subtle', reducedMotionRespected: true },
  },
  pages: [
    {
      id: 'home',
      path: '/',
      title: 'Home',
      seo: { title: 'Sharma Taxi', description: 'Taxi in Indore' },
      sections: [
        {
          id: 's1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'Airport drop', description: 'Any time' }] },
        },
      ],
    },
  ],
  navigation: { items: [{ label: 'Home', target: '/' }] },
  footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'none' },
  integrations: { analyticsId: null, metaPixelId: null, chatbot: { enabled: false } },
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkspaceError ? e.code : `other:${String(e)}`;
  }
};

beforeAll(async () => {
  migrator = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.migrator, max: 2 });
  templateId = (
    await migrator.query<{ template_id: string }>(
      `SELECT template_id FROM app.operator_publish_builtin_template($1, $2, 'taxi', 'Review suite template.', '1.0', $3::jsonb, '{"fields":[]}'::jsonb, $4)`,
      [
        unique('rev').slice(0, 40),
        'Review suite',
        JSON.stringify(config),
        uuidv7().replace(/-/g, '').padEnd(64, '0'),
      ],
    )
  ).rows[0]!.template_id;
});
afterAll(async () => {
  await migrator.end();
  await visitor.close();
  await closeAll();
});

/** A project published to staging with one review link, and a client comment and approval through it. */
async function reviewed() {
  const ws = await workspaceWith(['admin', 'editor', 'viewer']);
  const editor = ws.members.editor!.id;
  const { id: projectId } = await projects.createProject(ws.owner.id, {
    workspaceId: ws.id,
    requestKey: uuidv7(),
    name: unique('Review'),
    category: 'taxi',
  });
  await builder.createDraftFromTemplate(editor, { workspaceId: ws.id, projectId, templateId });
  const { revision } = await builder.getDraft(editor, ws.id, projectId);
  const { versionId } = await publishing.publish(editor, {
    workspaceId: ws.id,
    projectId,
    kind: 'staging',
    expectedRevision: revision,
    publishKey: uuidv7(),
  });
  const link = await publishing.createStagingLink(editor, { workspaceId: ws.id, projectId });
  const say = (body: string, sectionId: string | null = 's1') =>
    visitor.addReviewComment({
      linkId: link.id,
      versionId,
      pageId: sectionId ? 'home' : null,
      sectionId,
      name: 'Ramesh',
      email: 'ramesh@example.test',
      body,
      ipHash: null,
    });
  return { ws, editor, projectId, versionId, link, say };
}

describe('feedback', () => {
  it('lists client comments newest first with version, pin, e-mail and replies; approvals with their version', async () => {
    const r = await reviewed();
    expect(await r.say('First: bigger phone number')).toBe('ok');
    expect(await r.say('Second: whole site is great', null)).toBe('ok');
    expect(
      await visitor.approveReviewVersion({
        linkId: r.link.id,
        versionId: r.versionId,
        name: 'Ramesh Sharma',
        email: null,
        ipHash: null,
      }),
    ).toBe('ok');

    const viewer = r.ws.members.viewer!.id;
    const feedback = await review.feedback(viewer, { workspaceId: r.ws.id, projectId: r.projectId });
    expect(feedback.open).toBe(2);
    expect(feedback.comments.map((c) => [c.body, c.pageId, c.sectionId])).toEqual([
      ['Second: whole site is great', null, null],
      ['First: bigger phone number', 'home', 's1'],
    ]);
    expect(feedback.comments[1]).toMatchObject({
      siteVersionId: r.versionId,
      versionNumber: 1,
      stagingLinkId: r.link.id,
      authorName: 'Ramesh',
      authorEmail: 'ramesh@example.test',
      resolvedAt: null,
      replies: [],
    });
    expect(feedback.approvals).toEqual([
      expect.objectContaining({
        siteVersionId: r.versionId,
        versionNumber: 1,
        approverName: 'Ramesh Sharma',
        approverEmail: null,
      }),
    ]);
  });

  it('a member of another workspace, and an unknown project, get NOT_FOUND', async () => {
    const r = await reviewed();
    const other = await workspaceWith();
    expect(
      await code(review.feedback(other.owner.id, { workspaceId: r.ws.id, projectId: r.projectId })),
    ).toBe('NOT_FOUND');
    expect(await code(review.feedback(r.editor, { workspaceId: r.ws.id, projectId: uuidv7() }))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('reply and resolve', () => {
  it('an editor replies (the client sees it) and marks the comment done and open again, audited', async () => {
    const r = await reviewed();
    await r.say('Change the photo');
    const [comment] = (await review.feedback(r.editor, { workspaceId: r.ws.id, projectId: r.projectId }))
      .comments;
    const { replyId } = await review.reply(r.editor, {
      workspaceId: r.ws.id,
      commentId: comment!.id,
      body: '  Done, new photo is up.  ',
    });

    const thread = await visitor.getReviewThread(r.link.id, r.versionId);
    expect(thread.find((t) => t.id === replyId)).toMatchObject({
      parentId: comment!.id,
      authorKind: 'member',
      authorName: null,
      body: 'Done, new photo is up.',
      pageId: 'home',
      sectionId: 's1',
    });

    expect(
      await review.setResolved(r.editor, { workspaceId: r.ws.id, commentId: comment!.id, resolved: true }),
    ).toEqual({ changed: true });
    expect(
      await review.setResolved(r.editor, { workspaceId: r.ws.id, commentId: comment!.id, resolved: true }),
    ).toEqual({ changed: false });
    const after = await review.feedback(r.editor, { workspaceId: r.ws.id, projectId: r.projectId });
    expect(after.open).toBe(0);
    expect(after.comments[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(after.comments[0]?.resolvedByName).toBeTruthy();
    expect(after.comments[0]?.replies).toEqual([
      expect.objectContaining({ id: replyId, body: 'Done, new photo is up.' }),
    ]);
    expect(
      (await visitor.getReviewThread(r.link.id, r.versionId)).find((t) => t.id === comment!.id)?.resolved,
    ).toBe(true);
    await review.setResolved(r.editor, { workspaceId: r.ws.id, commentId: comment!.id, resolved: false });
    expect((await review.feedback(r.editor, { workspaceId: r.ws.id, projectId: r.projectId })).open).toBe(1);

    const audit = await db.withTenant((await db.resolveTenantScope(r.ws.owner.id, r.ws.id))!, (tx) =>
      tx.auditLog.findMany({
        where: { targetId: comment!.id, action: { startsWith: 'review.' } },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorId: true, projectId: true, metadata: true },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual([
      'review.comment_replied',
      'review.comment_resolved',
      'review.comment_reopened',
    ]);
    expect(audit.every((a) => a.actorId === r.editor && a.projectId === r.projectId)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('photo');
  });

  it('a viewer may read but not reply or resolve; a reply to a reply or an empty reply is refused', async () => {
    const r = await reviewed();
    await r.say('Hello');
    const [comment] = (await review.feedback(r.editor, { workspaceId: r.ws.id, projectId: r.projectId }))
      .comments;
    const viewer = r.ws.members.viewer!.id;
    expect(
      await code(review.reply(viewer, { workspaceId: r.ws.id, commentId: comment!.id, body: 'x' })),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        review.setResolved(viewer, { workspaceId: r.ws.id, commentId: comment!.id, resolved: true }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(review.reply(r.editor, { workspaceId: r.ws.id, commentId: comment!.id, body: '   ' })),
    ).toBe('INVALID_INPUT');
    const { replyId } = await review.reply(r.editor, {
      workspaceId: r.ws.id,
      commentId: comment!.id,
      body: 'ok',
    });
    expect(await code(review.reply(r.editor, { workspaceId: r.ws.id, commentId: replyId, body: 'x' }))).toBe(
      'NOT_FOUND',
    );
    expect(
      await code(review.setResolved(r.editor, { workspaceId: r.ws.id, commentId: replyId, resolved: true })),
    ).toBe('NOT_FOUND');
  });

  it("another workspace cannot reply to or resolve this workspace's comment", async () => {
    const r = await reviewed();
    await r.say('Hello');
    const [comment] = (await review.feedback(r.editor, { workspaceId: r.ws.id, projectId: r.projectId }))
      .comments;
    const other = await workspaceWith();
    expect(
      await code(review.reply(other.owner.id, { workspaceId: other.id, commentId: comment!.id, body: 'x' })),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        review.setResolved(other.owner.id, { workspaceId: other.id, commentId: comment!.id, resolved: true }),
      ),
    ).toBe('NOT_FOUND');
  });
});
