/**
 * P3 S8b: the client-approval gate, automatic review statuses and review notifications, against the local database
 * (FR-PUB-06, FR-PRJ-02, FR-NOT-01; plan approved by the Owner 2026-11-18). Real publishes and review links; the
 * client acts through the app_public functions apps/sites calls.
 *
 *   - the workspace policy: owners and admins switch it, audited, a repeat writes nothing;
 *   - the gate: with the policy on, Live takes only content a client approved exactly (service and trigger);
 *     a change after the approval needs a new one; rollback is exempt; with the policy off nothing changes;
 *   - statuses: a review link moves Draft -> In review, an approval In review -> Approved, both as the system
 *     and audited; nothing moves from other statuses; a member cannot fake the system move;
 *   - notifications: approval at once, comments once per link per 15 minutes, to the creator, owners and admins,
 *     by their choices, with e-mail outbox rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from '@platform/db';
import { createPublicDatabase } from '@platform/db/public';
import { LOCAL_DATABASE_URLS, sqlStates } from '@platform/db/testing';
import { createBuilderService } from '../../src/builder';
import { WorkspaceError } from '../../src/errors';
import { createPublishingService } from '../../src/publishing';
import { closeAll, db, notifications, outbox, projects, service, unique, workspaceWith } from '../harness';

const SECRET = 'approval-suite-secret-0123456789-abcdefg';
const builder = createBuilderService({ db });
const publishing = createPublishingService({
  db,
  outbox,
  staging: { host: 'preview.sites.localhost', secret: SECRET },
});
const visitor = createPublicDatabase({ connectionString: LOCAL_DATABASE_URLS.public });
let migrator: pg.Pool;
let templateId: string;

const DEMO_PHONE = '+919800000000';
const config = {
  schemaVersion: '1.0',
  business: { name: 'Gupta Sweets', category: 'gym', phone: DEMO_PHONE },
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
      seo: { title: 'Gupta Sweets', description: 'Sweets in Indore' },
      sections: [
        {
          id: 's1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'Kaju katli', description: 'Fresh every day' }] },
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
      `SELECT template_id FROM app.operator_publish_builtin_template($1, $2, 'gym', 'Approval suite template.', '1.0', $3::jsonb, '{"fields":[]}'::jsonb, $4)`,
      [
        unique('apr').slice(0, 40),
        'Approval suite',
        JSON.stringify(config),
        uuidv7().replace(/-/g, '').padEnd(64, '0'),
      ],
    )
  ).rows[0]!.template_id;
});
/**
 * Raw rows across recipients, and the clock moved back for the 15-minute window. The tables force RLS for their
 * owner too, so the suite gives the owner (migrator) a policy inside one transaction: rolled back after a read,
 * dropped before commit after a write. Nothing outlives the call.
 */
async function asOwner<R extends pg.QueryResultRow>(
  sql: string,
  params: unknown[],
): Promise<pg.QueryResult<R>> {
  const client = await migrator.connect();
  const write = /^s*update/i.test(sql);
  try {
    await client.query('BEGIN');
    for (const table of ['notifications', 'outbox_events'])
      await client.query(
        `CREATE POLICY suite_owner ON app.${table} FOR ALL TO migrator USING (true) WITH CHECK (true)`,
      );
    const result = await client.query<R>(sql, params);
    if (write) {
      for (const table of ['notifications', 'outbox_events'])
        await client.query(`DROP POLICY suite_owner ON app.${table}`);
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await migrator.end();
  await visitor.close();
  await closeAll();
});

/** A project (made by the editor) with a draft whose phone is real, so Live preflight passes. */
async function project() {
  const ws = await workspaceWith(['admin', 'editor', 'viewer']);
  const editor = ws.members.editor!.id;
  const owner = ws.owner.id;
  const { id: projectId } = await projects.createProject(editor, {
    workspaceId: ws.id,
    requestKey: uuidv7(),
    name: unique('Approval'),
    category: 'gym',
  });
  await builder.createDraftFromTemplate(editor, { workspaceId: ws.id, projectId, templateId });
  await builder.acquireLock(editor, { workspaceId: ws.id, projectId });
  const at = <T extends object>(input: T = {} as T) => ({ workspaceId: ws.id, projectId, ...input });
  const setPhone = async (phone: string) => {
    const { revision } = await builder.getDraft(editor, ws.id, projectId);
    await builder.applyChange(editor, {
      ...at(),
      expectedRevision: revision,
      changeId: uuidv7(),
      // The template's own name and phone are demo content that blocks Live (preflight decision 3).
      operations: [{ op: 'updateBusiness', value: { phone, name: `Gupta Sweets ${phone.slice(-4)}` } }],
    });
  };
  const publish = async (actor: string, kind: 'staging' | 'live') => {
    const { revision } = await builder.getDraft(editor, ws.id, projectId);
    return publishing.publish(actor, { ...at({ kind }), expectedRevision: revision, publishKey: uuidv7() });
  };
  const approve = async (linkId: string, versionId: string) =>
    visitor.approveReviewVersion({ linkId, versionId, name: 'Ramesh Gupta', email: null, ipHash: null });
  const comment = async (linkId: string, versionId: string, body: string) =>
    visitor.addReviewComment({
      linkId,
      versionId,
      pageId: 'home',
      sectionId: 's1',
      name: 'Ramesh Gupta',
      email: null,
      body,
      ipHash: null,
    });
  const scope = async () => (await db.resolveTenantScope(owner, ws.id))!;
  const status = async () =>
    db.withTenant(await scope(), (tx) =>
      tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } }),
    );
  const systemMoves = async () =>
    db.withTenant(await scope(), (tx) =>
      tx.auditLog.findMany({
        where: { projectId, action: 'project.status_changed', actorType: 'system' },
        orderBy: { createdAt: 'asc' },
        select: { actorId: true, metadata: true, targetId: true },
      }),
    );
  await setPhone('+919811112222');
  return {
    ws,
    owner,
    editor,
    projectId,
    at,
    setPhone,
    publish,
    approve,
    comment,
    scope,
    status,
    systemMoves,
  };
}

describe('the workspace policy (FR-PUB-06)', () => {
  it('owners and admins switch it, audited; editors and viewers cannot; a repeat writes nothing', async () => {
    const ws = await workspaceWith(['admin', 'editor', 'viewer']);
    const input = { workspaceId: ws.id, required: true };
    expect(await code(service.setClientApprovalPolicy(ws.members.editor!.id, input))).toBe('FORBIDDEN');
    expect(await code(service.setClientApprovalPolicy(ws.members.viewer!.id, input))).toBe('FORBIDDEN');
    expect(await code(service.setClientApprovalPolicy(ws.owner.id, { ...input, required: 'yes' }))).toBe(
      'INVALID_INPUT',
    );
    expect(await service.setClientApprovalPolicy(ws.members.admin!.id, input)).toEqual({ changed: true });
    expect(await service.setClientApprovalPolicy(ws.owner.id, input)).toEqual({ changed: false });
    expect((await service.resolveBySlug(ws.owner.id, ws.slug))!.requireClientApproval).toBe(true);
    expect(await service.setClientApprovalPolicy(ws.owner.id, { ...input, required: false })).toEqual({
      changed: true,
    });
    const audit = await db.withTenant((await db.resolveTenantScope(ws.owner.id, ws.id))!, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'workspace.client_approval_policy_changed', result: 'success' },
        orderBy: { createdAt: 'asc' },
        select: { actorId: true, metadata: true, targetId: true },
      }),
    );
    expect(audit).toEqual([
      { actorId: ws.members.admin!.id, metadata: { required: true }, targetId: ws.id },
      { actorId: ws.owner.id, metadata: { required: false }, targetId: ws.id },
    ]);
  });

  it('an editor cannot switch it in the database either (RLS manager_update)', async () => {
    const ws = await workspaceWith(['editor']);
    const scope = (await db.resolveTenantScope(ws.members.editor!.id, ws.id))!;
    const count = await db.withTenant(scope, (tx) =>
      tx.workspace.updateMany({ where: { id: ws.id }, data: { requireClientApproval: true } }),
    );
    expect(count.count).toBe(0);
    expect((await service.resolveBySlug(ws.owner.id, ws.slug))!.requireClientApproval).toBe(false);
  });
});

describe('the Live gate', () => {
  it('policy off: Live publishes without an approval, and the panel reports no gate', async () => {
    const p = await project();
    expect((await p.publish(p.owner, 'live')).kind).toBe('live');
    const s = await publishing.status(p.owner, p.ws.id, p.projectId);
    expect(s.approval).toEqual({ required: false, latest: null, draftApproved: null });
  });

  it('policy on: refused until the client approves exactly that content; a later change needs a new approval', async () => {
    const p = await project();
    await service.setClientApprovalPolicy(p.owner, { workspaceId: p.ws.id, required: true });
    expect(await code(p.publish(p.owner, 'live'))).toBe('APPROVAL_REQUIRED');
    expect((await publishing.status(p.owner, p.ws.id, p.projectId)).approval).toMatchObject({
      required: true,
      latest: null,
      draftApproved: false,
    });

    const staging = await p.publish(p.editor, 'staging');
    const link = await publishing.createStagingLink(p.editor, p.at());
    expect(await code(p.publish(p.owner, 'live'))).toBe('APPROVAL_REQUIRED');
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    const approved = await publishing.status(p.owner, p.ws.id, p.projectId);
    expect(approved.approval).toMatchObject({
      required: true,
      latest: { number: staging.number, approverName: 'Ramesh Gupta' },
      draftApproved: true,
    });
    const live = await p.publish(p.owner, 'live');
    expect(live.kind).toBe('live');

    // A change after the approval: the same draft no longer matches anything the client saw.
    await p.setPhone('+919833334444');
    expect((await publishing.status(p.owner, p.ws.id, p.projectId)).approval.draftApproved).toBe(false);
    expect(await code(p.publish(p.owner, 'live'))).toBe('APPROVAL_REQUIRED');
    // Changing it back to exactly the approved content is approved content again.
    await p.setPhone('+919811112222');
    expect((await p.publish(p.owner, 'live')).kind).toBe('live');
    // Staging is never gated.
    await p.setPhone('+919855556666');
    expect((await p.publish(p.editor, 'staging')).kind).toBe('staging');
  });

  it('an approval stays valid after its link is turned off (an approval is an immutable record)', async () => {
    const p = await project();
    await service.setClientApprovalPolicy(p.owner, { workspaceId: p.ws.id, required: true });
    const staging = await p.publish(p.editor, 'staging');
    const link = await publishing.createStagingLink(p.editor, p.at());
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    await publishing.revokeStagingLink(p.editor, { workspaceId: p.ws.id, linkId: link.id });
    expect((await p.publish(p.owner, 'live')).kind).toBe('live');
  });

  it('rollback is exempt: an earlier Live version made before the policy goes back on Live', async () => {
    const p = await project();
    const first = await p.publish(p.owner, 'live');
    await p.setPhone('+919877778888');
    const second = await p.publish(p.owner, 'live');
    await service.setClientApprovalPolicy(p.owner, { workspaceId: p.ws.id, required: true });
    const back = await publishing.rollback(p.owner, {
      ...p.at(),
      versionId: first.versionId,
      expectedLiveVersionId: second.versionId,
    });
    expect(back).toMatchObject({ versionId: first.versionId, replayed: false });
  });

  it('the trigger refuses an unapproved Live version written past the service (P5105)', async () => {
    const p = await project();
    await service.setClientApprovalPolicy(p.owner, { workspaceId: p.ws.id, required: true });
    const staging = await p.publish(p.editor, 'staging');
    const stored = await db.withTenant(await p.scope(), (tx) =>
      tx.siteVersion.findUniqueOrThrow({
        where: { id: staging.versionId },
        select: { config: true, schemaVersion: true, checksum: true },
      }),
    );
    const memberScope = await p.scope();
    const write = (checksum: string) =>
      db.withTenant(memberScope, (tx) =>
        tx.siteVersion.create({
          data: {
            workspaceId: p.ws.id,
            projectId: p.projectId,
            kind: 'live',
            config: stored.config as object,
            schemaVersion: stored.schemaVersion,
            checksum,
            sourceDraftRevision: 1,
          },
          select: { id: true },
        }),
      );
    let states: string[] = [];
    try {
      await write(stored.checksum);
    } catch (e) {
      states = sqlStates(e);
    }
    expect(states).toContain('P5105');
    // Once the client approved that content, the same write passes.
    const link = await publishing.createStagingLink(p.editor, p.at());
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    expect((await write(stored.checksum)).id).toBeTruthy();
  });
});

describe('automatic review statuses (FR-PRJ-02)', () => {
  it('a review link moves Draft to In review and an approval In review to Approved, as the audited system', async () => {
    const p = await project();
    const staging = await p.publish(p.editor, 'staging');
    expect((await p.status()).status).toBe('draft');
    const link = await publishing.createStagingLink(p.editor, p.at());
    expect((await p.status()).status).toBe('in_review');
    // A second link does not move it again.
    const second = await publishing.createStagingLink(p.editor, p.at());
    expect((await p.status()).status).toBe('in_review');
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    expect((await p.status()).status).toBe('approved');
    // A second approval (another link) is recorded but moves nothing.
    expect(await p.approve(second.id, staging.versionId)).toBe('ok');
    expect((await p.status()).status).toBe('approved');
    expect(await p.systemMoves()).toEqual([
      {
        actorId: null,
        targetId: p.projectId,
        metadata: { from: 'draft', to: 'in_review', reason: 'review_link_created' },
      },
      {
        actorId: null,
        targetId: p.projectId,
        metadata: { from: 'in_review', to: 'approved', reason: 'client_approved' },
      },
    ]);
  });

  it('nothing moves from another status: a member sent it back to Draft, or it is Live', async () => {
    const p = await project();
    const staging = await p.publish(p.editor, 'staging');
    const link = await publishing.createStagingLink(p.editor, p.at());
    await projects.transitionProject(p.editor, { ...p.at(), from: 'in_review', to: 'draft' });
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    expect((await p.status()).status).toBe('draft');
    expect((await p.systemMoves()).map((m) => (m.metadata as { to: string }).to)).toEqual(['in_review']);
  });

  it('a member cannot fake the system move, even with the flag set in their own transaction', async () => {
    const p = await project();
    await p.publish(p.editor, 'staging');
    await publishing.createStagingLink(p.editor, p.at());
    const scope = (await db.resolveTenantScope(p.editor, p.ws.id))!;
    let states: string[] = [];
    try {
      await db.withTenant(scope, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.review_transition', 'on', true)`;
        await tx.$executeRaw`UPDATE app.projects SET status = 'approved' WHERE id = ${p.projectId}::uuid`;
      });
    } catch (e) {
      states = sqlStates(e);
    }
    expect(states).toContain('42501');
    expect((await p.status()).status).toBe('in_review');
  });
});

describe('review notifications (FR-NOT-01)', () => {
  const inbox = async (userId: string, workspaceId: string) =>
    (await notifications.listNotifications(userId, workspaceId)).items.filter((n) =>
      n.type.startsWith('review.'),
    );

  it('an approval notifies the creator, owners and admins at once, with e-mail outbox rows', async () => {
    const p = await project();
    const staging = await p.publish(p.editor, 'staging');
    const link = await publishing.createStagingLink(p.editor, p.at());
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    for (const who of [p.owner, p.ws.members.admin!.id, p.editor]) {
      const items = await inbox(who, p.ws.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: 'review.client_approved',
        category: 'project.client_review',
        payload: {
          projectId: p.projectId,
          stagingLinkId: link.id,
          versionId: staging.versionId,
          number: String(staging.number),
        },
      });
      // Ids and codes only: the client's name is not in the notice.
      expect(JSON.stringify(items[0]!.payload)).not.toContain('Ramesh');
    }
    expect(await inbox(p.ws.members.viewer!.id, p.ws.id)).toHaveLength(0);
    // One fresh e-mail outbox row per notice (defaults: e-mail on), ids only.
    const mails = await asOwner<{ attempts: number; dispatched: boolean; payload: object }>(
      `SELECT o.attempts, o.dispatched_at IS NOT NULL AS dispatched, o.payload
         FROM app.outbox_events o
         JOIN app.notifications n ON n.id = (o.payload ->> 'notificationId')::uuid
        WHERE o.workspace_id = $1 AND o.event = 'notification.email.requested.v1'
          AND n.type = 'review.client_approved'`,
      [p.ws.id],
    );
    expect(mails.rows).toHaveLength(3);
    expect(mails.rows.every((m) => m.attempts === 0 && !m.dispatched)).toBe(true);
    expect(Object.keys(mails.rows[0]!.payload).sort()).toEqual(['notificationId', 'workspaceId']);
  });

  it('comments notify once per link per 15 minutes, and the inbox counts the comments in the window', async () => {
    const p = await project();
    const staging = await p.publish(p.editor, 'staging');
    const link = await publishing.createStagingLink(p.editor, p.at());
    for (const body of ['Bigger phone', 'Change the photo', 'Add Sunday hours'])
      expect(await p.comment(link.id, staging.versionId, body)).toBe('ok');
    let items = await inbox(p.owner, p.ws.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'review.client_commented', commentCount: 3 });

    // Another link has its own window.
    const other = await publishing.createStagingLink(p.editor, p.at());
    expect(await p.comment(other.id, staging.versionId, 'From the other link')).toBe('ok');
    items = await inbox(p.owner, p.ws.id);
    expect(items.map((n) => n.payload.stagingLinkId).sort()).toEqual([link.id, other.id].sort());

    // After the window, the next comment on the first link notifies again (time moved back as superuser).
    await asOwner(
      `UPDATE app.notifications SET created_at = created_at - interval '16 minutes'
        WHERE workspace_id = $1 AND type = 'review.client_commented' AND payload ->> 'stagingLinkId' = $2`,
      [p.ws.id, link.id],
    );
    expect(await p.comment(link.id, staging.versionId, 'One more thing')).toBe('ok');
    items = (await inbox(p.owner, p.ws.id)).filter((n) => n.payload.stagingLinkId === link.id);
    expect(items).toHaveLength(2);
    expect(items.map((n) => n.commentCount)).toEqual([1, 0]);
  });

  it('each member’s choices apply: both off means no notice, e-mail off means no outbox row', async () => {
    const p = await project();
    await notifications.savePreferences(p.owner, {
      workspaceId: p.ws.id,
      preferences: { 'project.client_review': { inApp: false, email: false } },
    });
    const admin = p.ws.members.admin!.id;
    await notifications.savePreferences(admin, {
      workspaceId: p.ws.id,
      preferences: { 'project.client_review': { inApp: true, email: false } },
    });
    const staging = await p.publish(p.editor, 'staging');
    const link = await publishing.createStagingLink(p.editor, p.at());
    expect(await p.approve(link.id, staging.versionId)).toBe('ok');
    const rows = await asOwner<{ user_id: string; id: string }>(
      `SELECT user_id, id FROM app.notifications WHERE workspace_id = $1 AND type = 'review.client_approved'`,
      [p.ws.id],
    );
    expect(rows.rows.map((r) => r.user_id).sort()).toEqual([admin, p.editor].sort());
    const mails = await asOwner<{ notification: string }>(
      `SELECT payload ->> 'notificationId' AS notification FROM app.outbox_events
        WHERE workspace_id = $1 AND event = 'notification.email.requested.v1'`,
      [p.ws.id],
    );
    const editorNotice = rows.rows.find((r) => r.user_id === p.editor)!.id;
    expect(mails.rows.map((m) => m.notification)).toEqual([editorNotice]);
  });
});
