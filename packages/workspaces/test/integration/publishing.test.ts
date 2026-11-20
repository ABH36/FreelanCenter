/**
 * P3 S7a: publishing against the local database (FR-PUB-01, FR-PUB-02, FR-PUB-04; approved 2026-11-15). Covers the
 * publish transaction (replay, stale revision, preflight, roles, version numbers, immutability, asset snapshot
 * shape), the live host path apps/sites uses (resolve_host `live` + get_published_version as app_public, host cache
 * invalidation through the outbox) and staging links (get_staging_site: ok, revoked, unavailable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from '@platform/db';
import { createPublicDatabase } from '@platform/db/public';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { createHostResolver, hostCacheKey, verifyStagingToken } from '@platform/hosting';
import { replaceDemoSeo } from '@platform/schema';
import { createBuilderService } from '../../src/builder';
import { WorkspaceError } from '../../src/errors';
import { createPublishingService, versionChecksum } from '../../src/publishing';
import { closeAll, db, hostCache, outbox, projects, runJobs, unique, workspaceWith } from '../harness';

const SECRET = 'staging-suite-secret-0123456789-abcdefgh';
const staging = { host: 'preview.sites.localhost', secret: SECRET };
const builder = createBuilderService({ db });
const publishing = createPublishingService({ db, outbox, staging });
const visitor = createPublicDatabase({ connectionString: LOCAL_DATABASE_URLS.public });
const resolver = createHostResolver({ cache: hostCache, lookup: (h) => visitor.resolveHost(h) });
let migrator: pg.Pool;
let templateId: string;

const DEMO_PHONE = '+919800000000';
const config = {
  schemaVersion: '1.0',
  business: { name: 'Iron Pulse Fitness', category: 'gym', phone: DEMO_PHONE },
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
      seo: { title: 'Iron Pulse Fitness | Gym in Indore', description: 'Gym in Indore' },
      sections: [
        {
          id: 's1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'Personal training', description: 'One to one' }] },
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
      `SELECT template_id FROM app.operator_publish_builtin_template($1, $2, 'gym', 'Publishing suite template.', '1.0', $3::jsonb, '{"fields":[]}'::jsonb, $4)`,
      [
        unique('pub').slice(0, 40),
        'Publishing suite',
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

/** A project with a draft from the template; the editor holds the lock. */
async function project() {
  const ws = await workspaceWith(['admin', 'editor', 'viewer']);
  const editor = ws.members.editor!.id;
  const { id: projectId } = await projects.createProject(ws.owner.id, {
    workspaceId: ws.id,
    requestKey: uuidv7(),
    name: unique('Publish'),
    category: 'gym',
  });
  await builder.createDraftFromTemplate(editor, { workspaceId: ws.id, projectId, templateId });
  await builder.acquireLock(editor, { workspaceId: ws.id, projectId });
  const at = <T extends object>(input: T) => ({ workspaceId: ws.id, projectId, ...input });
  const setPhone = async (phone: string) => {
    const { revision, config, demoBusinessName } = await builder.getDraft(editor, ws.id, projectId);
    const name = `Sharma Gym ${phone.slice(-4)}`;
    return builder.applyChange(editor, {
      ...at({}),
      expectedRevision: revision,
      changeId: uuidv7(),
      // P3 S9d: renaming also replaces the template's sample name in the page search texts (one change).
      operations: [
        { op: 'updateBusiness', value: { phone, name } },
        ...replaceDemoSeo({ ...config, business: { ...config.business, name } }, demoBusinessName),
      ],
    });
  };
  const host = (
    await db.withTenant((await db.resolveTenantScope(ws.owner.id, ws.id))!, (tx) =>
      tx.domain.findFirstOrThrow({ where: { projectId }, select: { hostname: true } }),
    )
  ).hostname;
  return { ws, editor, projectId, at, setPhone, host };
}

describe('preflight (FR-PUB-04)', () => {
  it('the template demo phone blocks Live and only warns for Staging (decision 3)', async () => {
    const { ws, at } = await project();
    const viewer = ws.members.viewer!.id;
    const live = await publishing.preflight(viewer, at({ kind: 'live' }));
    expect(live.ok).toBe(false);
    expect(live.checks[0]).toMatchObject({ rule: 'demo-contact', level: 'blocking' });
    const stage = await publishing.preflight(viewer, at({ kind: 'staging' }));
    expect(stage.ok).toBe(true);
    expect(stage.checks.find((c) => c.rule === 'demo-contact')?.level).toBe('warning');
  });

  it('P3 S9d (DG-40): the sample name left in page search texts blocks Live until it is replaced', async () => {
    const { ws, editor, projectId, at } = await project();
    const viewer = ws.members.viewer!.id;
    const draft = await builder.getDraft(viewer, ws.id, projectId);
    expect(draft.demoBusinessName).toBeTruthy();
    expect(draft.config.business.name).toBe(draft.demoBusinessName);
    // A new name and phone, but the page search texts still name the template's business.
    const name = unique('Verma Fitness');
    await builder.applyChange(editor, {
      ...at({}),
      expectedRevision: draft.revision,
      changeId: uuidv7(),
      operations: [
        {
          op: 'updateBusiness',
          value: { name, phone: '+919877776666', whatsapp: '+919877776666', email: 'hi@verma.test' },
        },
      ],
    });
    const blocked = await publishing.preflight(viewer, at({ kind: 'live' }));
    expect(blocked.ok).toBe(false);
    expect(blocked.checks.find((c) => c.rule === 'demo-seo')).toMatchObject({ level: 'blocking' });
    expect(blocked.checks.filter((c) => c.rule === 'demo-contact').map((c) => c.message)).toEqual([]);
    const before = await builder.getDraft(editor, ws.id, projectId);
    await expect(
      publishing.publish(editor, {
        ...at({ kind: 'staging' }),
        expectedRevision: before.revision,
        publishKey: uuidv7(),
      }),
    ).resolves.toMatchObject({ kind: 'staging' });

    // The editor's button: one change, undoable, and Live is no longer blocked by it.
    const ops = replaceDemoSeo(before.config, before.demoBusinessName);
    expect(ops.length).toBeGreaterThan(0);
    await builder.applyChange(editor, {
      ...at({}),
      expectedRevision: before.revision,
      changeId: uuidv7(),
      operations: ops,
    });
    const after = await builder.getDraft(editor, ws.id, projectId);
    expect(after.config.pages.some((p) => (p.seo?.title ?? '').includes(name))).toBe(true);
    const fixed = await publishing.preflight(viewer, at({ kind: 'live' }));
    expect(fixed.checks.some((c) => c.rule === 'demo-seo')).toBe(false);
  });
});

describe('publish (FR-PUB-01/02)', () => {
  it('staging by an editor: immutable version 1, pointer, audit; a retry replays; live by an editor is refused', async () => {
    const { ws, editor, projectId, at } = await project();
    const key = uuidv7();
    const first = await publishing.publish(
      editor,
      at({ kind: 'staging', expectedRevision: 1, publishKey: key }),
    );
    expect(first).toMatchObject({ kind: 'staging', number: 1, replayed: false });
    expect(first.warnings).toBeGreaterThan(0);
    const again = await publishing.publish(
      editor,
      at({ kind: 'staging', expectedRevision: 1, publishKey: key }),
    );
    expect(again).toMatchObject({ versionId: first.versionId, number: 1, replayed: true });
    expect(
      await code(publishing.publish(editor, at({ kind: 'live', expectedRevision: 1, publishKey: key }))),
    ).toBe('FORBIDDEN');

    const scope = (await db.resolveTenantScope(ws.owner.id, ws.id))!;
    const rows = await db.withTenant(scope, async (tx) => ({
      versions: await tx.siteVersion.findMany({ where: { projectId } }),
      pointers: await tx.sitePointer.findMany({ where: { projectId } }),
      audit: await tx.auditLog.findMany({ where: { projectId, action: 'site.published_staging' } }),
    }));
    expect(rows.versions).toHaveLength(1);
    const v = rows.versions[0]!;
    expect(v).toMatchObject({
      kind: 'staging',
      number: 1,
      sourceDraftRevision: 1,
      createdBy: editor,
      assets: {},
    });
    expect(v.checksum).toBe(versionChecksum(v.config, v.assets));
    expect(rows.pointers).toEqual([expect.objectContaining({ kind: 'staging', siteVersionId: v.id })]);
    expect(rows.audit).toHaveLength(1);
    expect(rows.audit[0]!.metadata).toMatchObject({ kind: 'staging', number: 1, draft_revision: 1 });
    // Immutable (S1 triggers, tested in builder-model.test.ts): app_user holds no UPDATE grant on it either.
  });

  it('a stale revision is DRAFT_CONFLICT; the demo phone blocks Live with the reason; a viewer cannot publish', async () => {
    const { ws, at, setPhone } = await project();
    const owner = ws.owner.id;
    expect(
      await code(
        publishing.publish(owner, at({ kind: 'staging', expectedRevision: 7, publishKey: uuidv7() })),
      ),
    ).toBe('DRAFT_CONFLICT');
    try {
      await publishing.publish(owner, at({ kind: 'live', expectedRevision: 1, publishKey: uuidv7() }));
      expect.unreachable();
    } catch (e) {
      expect((e as WorkspaceError).code).toBe('PREFLIGHT_BLOCKED');
      expect(Object.values((e as WorkspaceError).fieldErrors).join(' ')).toMatch(
        /sample business name and phone number/,
      );
    }
    expect(
      await code(
        publishing.publish(
          ws.members.viewer!.id,
          at({ kind: 'staging', expectedRevision: 1, publishKey: uuidv7() }),
        ),
      ),
    ).toBe('FORBIDDEN');
    await setPhone('+919811111111');
    expect(
      await code(publishing.publish(owner, at({ kind: 'live', expectedRevision: 2, publishKey: uuidv7() }))),
    ).toBe('ok');
  });

  it('Live reaches apps/sites: resolve_host says live with the version, the cache is invalidated, numbers go on', async () => {
    const { ws, projectId, at, setPhone, host } = await project();
    const owner = ws.owner.id;
    await runJobs();
    expect((await resolver.resolve(host)).resolution.outcome).toBe('placeholder');
    expect((await resolver.resolve(host)).source).toBe('cache');

    await setPhone('+919822222222');
    await publishing.publish(owner, at({ kind: 'staging', expectedRevision: 2, publishKey: uuidv7() }));
    const live = await publishing.publish(
      owner,
      at({ kind: 'live', expectedRevision: 2, publishKey: uuidv7(), note: 'First launch' }),
    );
    expect(live.number).toBe(2);
    await runJobs();
    expect(await hostCache.get(hostCacheKey(host))).toBeNull();
    expect(await resolver.resolve(host)).toMatchObject({
      resolution: { outcome: 'live', workspaceId: ws.id, projectId, siteVersionId: live.versionId },
      source: 'database',
    });
    const content = await visitor.getPublishedVersion(live.versionId);
    expect(content).toMatchObject({ assets: {} });
    expect((content!.config as typeof config).business.phone).toBe('+919822222222');

    // A staging version is never served by id; an unknown id neither.
    const status = await publishing.status(ws.members.viewer!.id, ws.id, projectId);
    expect(status.live).toMatchObject({ id: live.versionId, number: 2, note: 'First launch' });
    expect(status.staging?.number).toBe(1);
    expect(status.recent.map((v) => v.number)).toEqual([2, 1]);
    expect(status.hosts).toEqual([host]);
    expect(await visitor.getPublishedVersion(status.staging!.id)).toBeNull();
    expect(await visitor.getPublishedVersion(uuidv7())).toBeNull();
  });
});

describe('staging links (decision 1)', () => {
  it('needs a staging version; shows it; follows the pointer; is revocable once; editors may share', async () => {
    const { ws, editor, projectId, at, setPhone } = await project();
    expect(await code(publishing.createStagingLink(editor, at({})))).toBe('NOT_PUBLISHED');
    const v1 = await publishing.publish(
      editor,
      at({ kind: 'staging', expectedRevision: 1, publishKey: uuidv7() }),
    );
    const link = await publishing.createStagingLink(editor, at({}));
    expect(link.expiresAt.getTime() - link.createdAt.getTime()).toBe(14 * 86_400_000);
    const token = link.url.split('/s/')[1]!;
    expect(link.url.startsWith('http://preview.sites.localhost:3001/s/')).toBe(true);
    const verdict = verifyStagingToken({ current: SECRET }, token);
    expect(verdict).toMatchObject({ ok: true, claims: { lid: link.id } });

    expect(await visitor.getStagingSite(link.id)).toMatchObject({
      status: 'ok',
      siteVersionId: v1.versionId,
    });
    await setPhone('+919833333333');
    const v2 = await publishing.publish(
      editor,
      at({ kind: 'staging', expectedRevision: 2, publishKey: uuidv7() }),
    );
    expect(await visitor.getStagingSite(link.id)).toMatchObject({
      status: 'ok',
      siteVersionId: v2.versionId,
    });

    // The status lists the same URL again (the token is minted from the row).
    const status = await publishing.status(ws.members.viewer!.id, ws.id, projectId);
    expect(status.stagingLinks.map((l) => l.url)).toEqual([link.url]);

    expect(
      await code(
        publishing.revokeStagingLink(ws.members.viewer!.id, { workspaceId: ws.id, linkId: link.id }),
      ),
    ).toBe('FORBIDDEN');
    expect(await publishing.revokeStagingLink(editor, { workspaceId: ws.id, linkId: link.id })).toEqual({
      revoked: true,
    });
    expect(await publishing.revokeStagingLink(editor, { workspaceId: ws.id, linkId: link.id })).toEqual({
      revoked: false,
    });
    const revoked = await visitor.getStagingSite(link.id);
    expect(revoked.status).toBe('revoked');
    expect(await visitor.getStagingSite(uuidv7())).toEqual({ status: 'unknown' });
    expect((await publishing.status(editor, ws.id, projectId)).stagingLinks).toEqual([]);
  });

  it('another workspace cannot see or revoke a link (IDOR = NOT_FOUND)', async () => {
    const a = await project();
    await publishing.publish(a.editor, a.at({ kind: 'staging', expectedRevision: 1, publishKey: uuidv7() }));
    const link = await publishing.createStagingLink(a.editor, a.at({}));
    const b = await workspaceWith(['editor']);
    expect(await code(publishing.revokeStagingLink(b.owner.id, { workspaceId: b.id, linkId: link.id }))).toBe(
      'NOT_FOUND',
    );
    expect(await code(publishing.status(b.owner.id, b.id, a.projectId))).toBe('NOT_FOUND');
    expect(
      await code(
        publishing.publish(b.owner.id, {
          workspaceId: b.id,
          projectId: a.projectId,
          kind: 'staging',
          expectedRevision: 1,
          publishKey: uuidv7(),
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});

/** P3 S7b (FR-PUB-03): history, diff, the stored version, rollback, restore into the draft. */
describe('history, diff and rollback (FR-PUB-03)', () => {
  /** Two live versions (phone 1, then phone 2) and one staging version in between. */
  async function twoLive() {
    const p = await project();
    const owner = p.ws.owner.id;
    await p.setPhone('+919844444444');
    const live1 = await publishing.publish(
      owner,
      p.at({ kind: 'live', expectedRevision: 2, publishKey: uuidv7(), note: 'Launch' }),
    );
    await p.setPhone('+919855555555');
    const staging = await publishing.publish(
      p.editor,
      p.at({ kind: 'staging', expectedRevision: 3, publishKey: uuidv7() }),
    );
    const live2 = await publishing.publish(
      owner,
      p.at({ kind: 'live', expectedRevision: 3, publishKey: uuidv7() }),
    );
    return { ...p, owner, live1, staging, live2 };
  }

  it('history lists every version newest first with author and note, filters by kind and pages', async () => {
    const { ws, at, live1, staging, live2, owner, editor } = await twoLive();
    const viewer = ws.members.viewer!.id;
    const all = await publishing.history(viewer, at({}));
    expect(all.versions.map((v) => [v.number, v.kind, v.current])).toEqual([
      [3, 'live', 'live'],
      [2, 'staging', 'staging'],
      [1, 'live', null],
    ]);
    expect(all.versions[2]).toMatchObject({ id: live1.versionId, note: 'Launch', publishedBy: owner });
    expect(all.versions[1]).toMatchObject({ id: staging.versionId, publishedBy: editor });
    expect(all).toMatchObject({
      next: null,
      liveVersionId: live2.versionId,
      stagingVersionId: staging.versionId,
    });
    const lives = await publishing.history(viewer, at({ kind: 'live' }));
    expect(lives.versions.map((v) => v.number)).toEqual([3, 1]);

    // Paging: 21 more staging versions -> a full page, then the rest after the cursor.
    for (let i = 0; i < 21; i++) {
      await publishing.publish(editor, at({ kind: 'staging', expectedRevision: 3, publishKey: uuidv7() }));
    }
    const first = await publishing.history(viewer, at({}));
    expect(first.versions).toHaveLength(20);
    expect(first.next).toBe(first.versions[19]!.id);
    const second = await publishing.history(viewer, at({ after: first.next }));
    expect(second.versions.map((v) => v.number)).toEqual([4, 3, 2, 1]);
    expect(second.next).toBeNull();
    expect(await code(publishing.history(viewer, at({ after: uuidv7() })))).toBe('NOT_FOUND');
    expect(await code(publishing.history(viewer, at({ kind: 'draft' })))).toBe('INVALID_INPUT');
  });

  it('compare names the changed field; getVersion returns the stored content', async () => {
    const { ws, at, live1, live2 } = await twoLive();
    const viewer = ws.members.viewer!.id;
    const cmp = await publishing.compare(viewer, at({ from: live1.versionId, to: live2.versionId }));
    expect(cmp.from.number).toBe(1);
    expect(cmp.to.number).toBe(3);
    expect(cmp.diff.entries).toContainEqual(
      expect.objectContaining({
        area: 'business',
        field: 'Phone',
        before: '+919844444444',
        after: '+919855555555',
      }),
    );
    const same = await publishing.compare(viewer, at({ from: live2.versionId, to: live2.versionId }));
    expect(same.diff.same).toBe(true);
    const stored = await publishing.getVersion(viewer, ws.id, live1.versionId);
    expect(stored).toMatchObject({ id: live1.versionId, number: 1, kind: 'live', assets: {} });
    expect(stored.config.business.phone).toBe('+919844444444');
  });

  it('rollback: the owner moves Live back, sites serve the old version at once, audited once; a retry changes nothing', async () => {
    const { ws, projectId, at, host, owner, live1, live2 } = await twoLive();
    await runJobs();
    await resolver.resolve(host); // warm the host cache with version 3
    const result = await publishing.rollback(
      owner,
      at({ versionId: live1.versionId, expectedLiveVersionId: live2.versionId }),
    );
    expect(result).toEqual({ versionId: live1.versionId, number: 1, replayed: false });
    await runJobs();
    expect(await hostCache.get(hostCacheKey(host))).toBeNull();
    expect((await resolver.resolve(host)).resolution).toMatchObject({
      outcome: 'live',
      siteVersionId: live1.versionId,
    });
    const again = await publishing.rollback(
      owner,
      at({ versionId: live1.versionId, expectedLiveVersionId: live2.versionId }),
    );
    expect(again).toEqual({ versionId: live1.versionId, number: 1, replayed: true });

    const scope = (await db.resolveTenantScope(owner, ws.id))!;
    const rows = await db.withTenant(scope, async (tx) => ({
      audit: await tx.auditLog.findMany({ where: { projectId, action: 'site.rolled_back' } }),
      pointer: await tx.sitePointer.findFirst({ where: { projectId, kind: 'live' } }),
    }));
    expect(rows.audit).toHaveLength(1);
    expect(rows.audit[0]).toMatchObject({ targetId: live1.versionId, actorId: owner });
    expect(rows.audit[0]!.metadata).toMatchObject({ from_number: 3, to_number: 1 });
    expect(rows.pointer).toMatchObject({ siteVersionId: live1.versionId, updatedBy: owner });

    // Forward again to version 3 ("any live version").
    await publishing.rollback(
      owner,
      at({ versionId: live2.versionId, expectedLiveVersionId: live1.versionId }),
    );
    expect((await publishing.status(owner, ws.id, projectId)).live?.number).toBe(3);
  });

  it('rollback is refused for editors, viewers, staging targets, a Live that moved, archived projects and other workspaces', async () => {
    const { ws, projectId, at, owner, editor, live1, live2, staging } = await twoLive();
    const back = { versionId: live1.versionId, expectedLiveVersionId: live2.versionId };
    expect(await code(publishing.rollback(editor, at(back)))).toBe('FORBIDDEN');
    expect(await code(publishing.rollback(ws.members.viewer!.id, at(back)))).toBe('FORBIDDEN');
    expect(
      await code(
        publishing.rollback(
          owner,
          at({ versionId: staging.versionId, expectedLiveVersionId: live2.versionId }),
        ),
      ),
    ).toBe('ROLLBACK_TARGET');
    expect(
      await code(
        publishing.rollback(
          owner,
          at({ versionId: live1.versionId, expectedLiveVersionId: staging.versionId }),
        ),
      ),
    ).toBe('LIVE_CHANGED');
    expect(
      await code(
        publishing.rollback(owner, at({ versionId: uuidv7(), expectedLiveVersionId: live2.versionId })),
      ),
    ).toBe('NOT_FOUND');
    expect(await code(publishing.rollback(ws.members.admin!.id, at(back)))).toBe('ok');

    const b = await workspaceWith([]);
    const foreign = { workspaceId: b.id, projectId };
    expect(await code(publishing.rollback(b.owner.id, { ...foreign, ...back }))).toBe('NOT_FOUND');
    expect(await code(publishing.history(b.owner.id, foreign))).toBe('NOT_FOUND');
    expect(await code(publishing.getVersion(b.owner.id, b.id, live1.versionId))).toBe('NOT_FOUND');
    expect(
      await code(publishing.compare(b.owner.id, { ...foreign, from: live1.versionId, to: live2.versionId })),
    ).toBe('NOT_FOUND');

    await projects.transitionProject(owner, { workspaceId: ws.id, projectId, from: 'draft', to: 'archived' });
    expect(
      await code(
        publishing.rollback(
          owner,
          at({ versionId: live2.versionId, expectedLiveVersionId: live1.versionId }),
        ),
      ),
    ).toBe('ARCHIVED');
  });

  it('restore into the draft: one undoable change set, needs the lock, Live untouched, retry-safe', async () => {
    const { ws, projectId, at, owner, editor, live1, live2 } = await twoLive();
    const before = await builder.getDraft(editor, ws.id, projectId);
    expect(before.config.business.phone).toBe('+919855555555');
    const input = at({ versionId: live1.versionId, expectedRevision: before.revision, changeId: uuidv7() });
    expect(await code(builder.restoreVersion(owner, input))).toBe('LOCK_REQUIRED');
    expect(await code(builder.restoreVersion(ws.members.viewer!.id, input))).toBe('FORBIDDEN');
    const restored = await builder.restoreVersion(editor, input);
    expect(restored.revision).toBe(before.revision + 1);
    expect(await builder.restoreVersion(editor, input)).toEqual(restored);
    expect(await code(builder.restoreVersion(editor, { ...input, versionId: live2.versionId }))).toBe(
      'IDEMPOTENCY_MISMATCH',
    );

    const after = await builder.getDraft(editor, ws.id, projectId);
    expect(after.config.business.phone).toBe('+919844444444');
    expect(after.canUndo).toBe(true);
    expect((await publishing.status(owner, ws.id, projectId)).live?.id).toBe(live2.versionId);

    await builder.undo(editor, at({ expectedRevision: after.revision }));
    const undone = await builder.getDraft(editor, ws.id, projectId);
    expect(undone.config).toEqual(before.config);
    await builder.redo(editor, at({ expectedRevision: undone.revision }));
    expect((await builder.getDraft(editor, ws.id, projectId)).config.business.phone).toBe('+919844444444');

    const scope = (await db.resolveTenantScope(owner, ws.id))!;
    const audit = await db.withTenant(scope, (tx) =>
      tx.auditLog.findMany({ where: { projectId, action: 'draft.version_restored' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ versionId: live1.versionId, number: 1, kind: 'live' });
    expect(
      await code(
        builder.restoreVersion(editor, at({ versionId: uuidv7(), expectedRevision: 1, changeId: uuidv7() })),
      ),
    ).toBe('NOT_FOUND');
  });
});
