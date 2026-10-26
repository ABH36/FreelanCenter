/**
 * Projects, lifecycle, platform subdomains, notifications, outbox, dead letters and the audit viewer against the
 * real database (P1 S6: FR-PRJ-01 P1 part, FR-PRJ-02..05, FR-DOM-01, FR-AUD-01 viewer, FR-NOT-01; Q9; S5 D4/D5).
 * As in S5, each database rule is proven twice: through the service (typed outcome) and with raw SQL as app_user.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { can } from '@platform/auth/rbac';
import type { TenantScope } from '@platform/db';
import { expectPgError } from '@platform/db/testing';
import { createInlineJobs } from '@platform/jobs';
import { AUDIT_PAGE_SIZE } from '../../src/audit';
import { PROJECT_STATUSES, PROJECT_TRANSITIONS, type ProjectStatus } from '../../src/lifecycle';
import { createNotificationEmailHandler } from '../../src/notification-delivery';
import { createOutbox } from '../../src/outbox';
import { PROJECT_LIMITS, createProjectService } from '../../src/projects';
import {
  BASE_URL,
  audit,
  closeAll,
  createUser,
  db,
  hostCacheHandler,
  mail,
  notifications,
  projects,
  runJobs,
  service,
  unique,
  workspaceWith,
} from '../harness';

afterAll(async () => {
  await closeAll();
});
beforeEach(() => mail.clear());

/**
 * Owner, admin and editor; the setup's invitation mails are flushed and the owner's two 'invitation accepted'
 * notifications are already read.
 */
async function teamWorkspace() {
  const ws = await workspaceWith(['admin', 'editor']);
  await runJobs();
  mail.clear();
  await notifications.markAllNotificationsRead(ws.owner.id, { workspaceId: ws.id });
  return ws;
}

const key = () => crypto.randomUUID();
const scopeOf = async (userId: string, workspaceId: string): Promise<TenantScope> =>
  (await db.resolveTenantScope(userId, workspaceId))!;

async function auditRows(ownerId: string, workspaceId: string, prefix = 'project.') {
  return db.withTenant(await scopeOf(ownerId, workspaceId), (tx) =>
    tx.auditLog.findMany({
      where: { action: { startsWith: prefix } },
      orderBy: { id: 'asc' },
      select: { action: true, result: true, actorId: true, projectId: true, metadata: true },
    }),
  );
}

async function newProject(ownerId: string, workspaceId: string, name = 'Sharma Taxi') {
  return projects.createProject(ownerId, { workspaceId, requestKey: key(), name });
}

/** Walks a project along the main path to `to` as the owner. */
async function moveTo(ownerId: string, workspaceId: string, projectId: string, to: ProjectStatus) {
  const path: ProjectStatus[] = ['draft', 'in_review', 'approved', 'live', 'paused'];
  if (to === 'archived') {
    await projects.transitionProject(ownerId, { workspaceId, projectId, from: 'draft', to: 'archived' });
    return;
  }
  for (let i = 1; i <= path.indexOf(to); i++) {
    await projects.transitionProject(ownerId, { workspaceId, projectId, from: path[i - 1], to: path[i] });
  }
}

describe('transition table (FR-PRJ-02)', () => {
  it('the TypeScript table equals app.project_transition_roles() for all 36 pairs and every role', async () => {
    const owner = await createUser();
    const rows = await db.withActor(
      owner.id,
      (tx) => tx.$queryRaw<Array<{ f: ProjectStatus; t: ProjectStatus; roles: string[] | null }>>`
        SELECT f::text AS f, t::text AS t, app.project_transition_roles(f, t)::text[] AS roles
          FROM unnest(enum_range(NULL::app.project_status)) f, unnest(enum_range(NULL::app.project_status)) t`,
    );
    expect(rows).toHaveLength(36);
    for (const { f, t, roles } of rows) {
      const ts = PROJECT_TRANSITIONS.find((x) => x.from === f && x.to === t);
      const expected = ts
        ? (['owner', 'admin', 'editor', 'viewer'] as const).filter((role) =>
            can({ kind: 'member', userId: 'u', workspaceId: 'w', role }, ts.capability),
          )
        : null;
      expect([f, t, roles ? [...roles].sort() : null]).toEqual([
        f,
        t,
        expected ? [...expected].sort() : null,
      ]);
    }
    expect(PROJECT_STATUSES).toHaveLength(6);
  });
});

describe('create, subdomain allocation (FR-PRJ-01, FR-DOM-01, Q9)', () => {
  it('creates a Draft with an active platform subdomain, the creator set by the database, audited', async () => {
    const ws = await workspaceWith();
    const name = `Sharma Taxi ${unique('n')}`;
    const { id } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name,
      category: 'taxi',
      city: 'Jaipur',
      contact: { name: 'Mr Sharma', phone: '+91 98765 43210', email: 'Sharma@Example.test' },
    });
    const p = await projects.getProject(ws.owner.id, ws.id, id);
    expect(p).toMatchObject({ status: 'draft', category: 'taxi', city: 'Jaipur' });
    expect(p.contact).toEqual({
      name: 'Mr Sharma',
      phone: '+91 98765 43210',
      email: 'sharma@example.test',
      whatsapp: null,
    });
    expect(p.health.subdomain?.status).toBe('active');
    expect(p.health.subdomain?.hostname).toBe(
      `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.sites.localhost`,
    );
    const row = await db.withTenant(await scopeOf(ws.owner.id, ws.id), (tx) =>
      tx.project.findUniqueOrThrow({ where: { id }, select: { createdBy: true } }),
    );
    expect(row.createdBy).toBe(ws.owner.id);
    const rows = await auditRows(ws.owner.id, ws.id);
    expect(rows).toEqual([
      expect.objectContaining({ action: 'project.created', result: 'success', projectId: id }),
    ]);
    // PII never reaches audit metadata.
    expect(JSON.stringify(rows)).not.toMatch(/sharma@|98765/i);
  });

  it('taken, reserved and non-ASCII names get `<label>-<4 random>`; another tenant cannot take a name', async () => {
    const a = await workspaceWith();
    const b = await workspaceWith();
    const name = `Gym ${unique('dup')}`;
    const label = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const host = async (ownerId: string, wsId: string, n: string) =>
      (await projects.getProject(ownerId, wsId, (await newProject(ownerId, wsId, n)).id)).health.subdomain!
        .hostname;
    expect(await host(a.owner.id, a.id, name)).toBe(`${label}.sites.localhost`);
    expect(await host(a.owner.id, a.id, name)).toMatch(
      new RegExp(`^${label}-[a-z0-9]{4}\\.sites\\.localhost$`),
    );
    expect(await host(b.owner.id, b.id, name)).toMatch(
      new RegExp(`^${label}-[a-z0-9]{4}\\.sites\\.localhost$`),
    );
    expect(await host(a.owner.id, a.id, 'Admin')).toMatch(/^admin-[a-z0-9]{4}\.sites\.localhost$/);
    expect(await host(a.owner.id, a.id, 'शर्मा टैक्सी')).toMatch(/^site-[a-z0-9]{4}\.sites\.localhost$/);
  });

  it('is idempotent on the request key: a repeat returns the same project, a different payload is refused, a race makes one', async () => {
    const ws = await workspaceWith();
    const k = key();
    const first = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: k,
      name: 'One',
    });
    const again = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: k,
      name: 'One',
    });
    expect(again.id).toBe(first.id);
    await expect(
      projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey: k, name: 'Other' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    const raceKey = key();
    const raced = await Promise.all(
      Array.from({ length: 6 }, () =>
        projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey: raceKey, name: 'Raced' }),
      ),
    );
    expect(new Set(raced.map((r) => r.id)).size).toBe(1);
    const created = (await auditRows(ws.owner.id, ws.id)).filter((r) => r.action === 'project.created');
    expect(created).toHaveLength(2);
  });

  it('validates input and refuses viewers (FORBIDDEN, audited as denied)', async () => {
    const ws = await workspaceWith(['editor', 'viewer']);
    await expect(
      projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey: 'nope', name: 'X' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey: key(), name: '  ' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      projects.createProject(ws.owner.id, {
        workspaceId: ws.id,
        requestKey: key(),
        name: 'X',
        category: 'casino',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      projects.createProject(ws.owner.id, {
        workspaceId: ws.id,
        requestKey: key(),
        name: 'X',
        contact: { name: 'C', email: 'not-an-address' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', fieldErrors: { 'contact.email': expect.any(String) } });
    await expect(newProject(ws.members.viewer!.id, ws.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await newProject(ws.members.editor!.id, ws.id)).id).toBeTruthy();
    const denied = await auditRows(ws.owner.id, ws.id);
    expect(denied).toContainEqual(
      expect.objectContaining({
        action: 'project.created',
        result: 'denied',
        actorId: ws.members.viewer!.id,
      }),
    );
  });

  it('the database refuses direct writes: viewer insert, domain insert, foreign allocation, job scope', async () => {
    const ws = await workspaceWith(['viewer']);
    const other = await workspaceWith();
    const { id } = await newProject(ws.owner.id, ws.id);
    const foreign = await newProject(other.owner.id, other.id);
    const viewer = await scopeOf(ws.members.viewer!.id, ws.id);
    await expectPgError(
      db.withTenant(viewer, (tx) => tx.project.create({ data: { workspaceId: ws.id, name: 'raw' } })),
      '42501',
    );
    expect(
      await db.withTenant(viewer, (tx) => tx.project.updateMany({ where: { id }, data: { name: 'raw' } })),
    ).toEqual({ count: 0 });
    const owner = await scopeOf(ws.owner.id, ws.id);
    await expectPgError(
      db.withTenant(
        owner,
        (tx) => tx.$executeRaw`INSERT INTO app.domains (workspace_id, project_id, hostname, type)
                     VALUES (${ws.id}::uuid, ${id}::uuid, 'www.some-bank.example', 'subdomain')`,
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(
        owner,
        (tx) =>
          tx.$queryRaw`SELECT * FROM app.allocate_platform_subdomain(${foreign.id}::uuid, 'stolen-label')`,
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(
        viewer,
        (tx) => tx.$queryRaw`SELECT * FROM app.allocate_platform_subdomain(${id}::uuid, 'viewer-label')`,
      ),
      '42501',
    );
    // A job scope has no role, so the role-gated UPDATE policy matches no row at all.
    expect(
      await db.withJobTenant(ws.id, (tx) =>
        tx.project.updateMany({ where: { id }, data: { status: 'in_review' } }),
      ),
    ).toEqual({ count: 0 });
  });
});

describe('lifecycle commands (FR-PRJ-02)', () => {
  it('walks the main path with the right roles, audited and idempotent', async () => {
    const ws = await workspaceWith(['admin', 'editor', 'viewer']);
    const editor = ws.members.editor!.id;
    const admin = ws.members.admin!.id;
    const { id } = await newProject(editor, ws.id);
    const t = (actor: string, from: ProjectStatus, to: ProjectStatus) =>
      projects.transitionProject(actor, { workspaceId: ws.id, projectId: id, from, to });

    await expect(t(ws.members.viewer!.id, 'draft', 'in_review')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await t(editor, 'draft', 'in_review')).toEqual({ status: 'in_review', changed: true });
    expect(await t(editor, 'draft', 'in_review')).toEqual({ status: 'in_review', changed: false });
    await expect(t(editor, 'in_review', 'approved')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await t(admin, 'in_review', 'approved')).toMatchObject({ changed: true });
    await expect(t(editor, 'approved', 'live')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await t(ws.owner.id, 'approved', 'live')).toMatchObject({ changed: true });
    expect(await t(admin, 'live', 'paused')).toMatchObject({ changed: true });
    expect(await t(admin, 'paused', 'live')).toMatchObject({ changed: true });
    await expect(t(editor, 'live', 'archived')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await t(admin, 'live', 'archived')).toMatchObject({ changed: true });
    expect(await t(admin, 'archived', 'draft')).toMatchObject({ status: 'draft', changed: true });

    const changes = (await auditRows(ws.owner.id, ws.id))
      .filter((r) => r.action === 'project.status_changed' && r.result === 'success')
      .map((r) => `${(r.metadata as { from: string }).from}>${(r.metadata as { to: string }).to}`);
    expect(changes).toEqual([
      'draft>in_review',
      'in_review>approved',
      'approved>live',
      'live>paused',
      'paused>live',
      'live>archived',
      'archived>draft',
    ]);
  });

  it('refuses a transition outside the table, a stale one, and edits of an archived project', async () => {
    const ws = await workspaceWith();
    const { id } = await newProject(ws.owner.id, ws.id);
    const t = (from: unknown, to: unknown) =>
      projects.transitionProject(ws.owner.id, { workspaceId: ws.id, projectId: id, from, to });
    await expect(t('draft', 'live')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(t('draft', 'deleted')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(t('in_review', 'approved')).rejects.toMatchObject({ code: 'STALE' });
    await t('draft', 'archived');
    await expect(
      projects.updateProject(ws.owner.id, { workspaceId: ws.id, projectId: id, name: 'Renamed' }),
    ).rejects.toMatchObject({ code: 'ARCHIVED' });
    const owner = await scopeOf(ws.owner.id, ws.id);
    await expectPgError(
      db.withTenant(owner, (tx) => tx.project.update({ where: { id }, data: { name: 'raw' } })),
      'P5003',
    );
    await expectPgError(
      db.withTenant(owner, (tx) => tx.project.update({ where: { id }, data: { status: 'live' } })),
      'P5002',
    );
  });

  it('the database repeats the role rules and the Live prerequisite', async () => {
    const ws = await workspaceWith(['editor']);
    const { id } = await newProject(ws.owner.id, ws.id);
    await moveTo(ws.owner.id, ws.id, id, 'approved');
    const editor = await scopeOf(ws.members.editor!.id, ws.id);
    await expectPgError(
      db.withTenant(editor, (tx) => tx.project.update({ where: { id }, data: { status: 'live' } })),
      '42501',
    );
    // Without an active platform subdomain a project cannot go live (P5006).
    const owner = await scopeOf(ws.owner.id, ws.id);
    await db.withTenant(owner, (tx) =>
      tx.domain.updateMany({ where: { projectId: id }, data: { deletedAt: new Date() } }),
    );
    await expect(
      projects.transitionProject(ws.owner.id, {
        workspaceId: ws.id,
        projectId: id,
        from: 'approved',
        to: 'live',
      }),
    ).rejects.toMatchObject({ code: 'NOT_LIVE_READY' });
    expect((await projects.getProject(ws.owner.id, ws.id, id)).transitions.map((t) => t.to)).not.toContain(
      'live',
    );
  });

  it('a concurrent transition race has exactly one winner (12 rounds of 8 racers)', async () => {
    const ws = await workspaceWith();
    for (let round = 0; round < 12; round++) {
      const { id } = await newProject(ws.owner.id, ws.id, `Race ${round}`);
      const targets: ProjectStatus[] = ['in_review', 'archived'];
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          projects.transitionProject(ws.owner.id, {
            workspaceId: ws.id,
            projectId: id,
            from: 'draft',
            to: targets[i % 2]!,
          }),
        ),
      );
      const winners = results.filter((r) => r.status === 'fulfilled' && r.value.changed);
      expect(winners, `round ${round}`).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'STALE' });
      }
      const final = (await projects.getProject(ws.owner.id, ws.id, id)).status;
      expect(final).toBe((winners[0] as PromiseFulfilledResult<{ status: ProjectStatus }>).value.status);
    }
    const audited = (await auditRows(ws.owner.id, ws.id)).filter(
      (r) => r.action === 'project.status_changed' && r.result === 'success',
    );
    expect(audited).toHaveLength(12);
  });

  it('refuses every command in a workspace scheduled for deletion (FR-WS-04 semantics)', async () => {
    const ws = await workspaceWith();
    const { id } = await newProject(ws.owner.id, ws.id);
    await service.requestDeletion(ws.owner.id, { workspaceId: ws.id, confirmSlug: ws.slug });
    await expect(newProject(ws.owner.id, ws.id)).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
    await expect(
      projects.transitionProject(ws.owner.id, {
        workspaceId: ws.id,
        projectId: id,
        from: 'draft',
        to: 'in_review',
      }),
    ).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
    expect((await projects.getProject(ws.owner.id, ws.id, id)).transitions).toEqual([]);
  });
});

describe('list, search, filter, paginate (FR-PRJ-04)', () => {
  it('searches name and city, filters status/category/client, pages without overlap', async () => {
    const ws = await workspaceWith();
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey: key(), name, ...extra });
    const gym = await mk('Iron Gym', { category: 'gym', city: 'Pune' });
    await mk('Royal Taxi', {
      category: 'taxi',
      city: 'Jaipur',
      contact: { name: 'Anita Rao', phone: '+91 90000 11111' },
    });
    await mk('100% Pure Salon', { category: 'salon' });
    await mk('1000 Pure Salon', { category: 'salon' });
    const archived = await mk('Old Site');
    await projects.transitionProject(ws.owner.id, {
      workspaceId: ws.id,
      projectId: archived.id,
      from: 'draft',
      to: 'archived',
    });
    await projects.transitionProject(ws.owner.id, {
      workspaceId: ws.id,
      projectId: gym.id,
      from: 'draft',
      to: 'in_review',
    });

    const names = async (filters: Record<string, unknown>) =>
      (await projects.listProjects(ws.owner.id, ws.id, filters)).items.map((p) => p.name).sort();
    expect(await names({ q: 'gym' })).toEqual(['Iron Gym']);
    expect(await names({ q: 'jaipur' })).toEqual(['Royal Taxi']);
    expect(await names({ q: '100%' })).toEqual(['100% Pure Salon']);
    expect(await names({ q: '_' })).toEqual([]);
    expect(await names({ category: 'salon' })).toEqual(['100% Pure Salon', '1000 Pure Salon']);
    expect(await names({ client: 'anita' })).toEqual(['Royal Taxi']);
    expect(await names({ client: '90000' })).toEqual(['Royal Taxi']);
    expect(await names({ status: 'in_review' })).toEqual(['Iron Gym']);
    expect(await names({})).not.toContain('Old Site');
    expect(await names({ status: 'archived' })).toEqual(['Old Site']);
    expect(await names({ status: 'all' })).toContain('Old Site');
    const gymRow = (await projects.listProjects(ws.owner.id, ws.id, { q: 'iron' })).items[0]!;
    expect(gymRow.health).toMatchObject({ pendingReview: true, subdomain: { status: 'active' } });

    for (let i = 0; i < PROJECT_LIMITS.pageSize + 5; i++) await mk(`Bulk ${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof projects.listProjects>> = await projects.listProjects(
        ws.owner.id,
        ws.id,
        { status: 'all', cursor },
      );
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(PROJECT_LIMITS.pageSize + 10);
  });

  it('another workspace sees nothing: list, get and commands answer NOT_FOUND like an unknown id', async () => {
    const a = await workspaceWith();
    const b = await workspaceWith();
    const { id } = await newProject(b.owner.id, b.id, 'Victim');
    expect((await projects.listProjects(a.owner.id, a.id, { q: 'Victim' })).items).toEqual([]);
    for (const projectId of [id, crypto.randomUUID()]) {
      await expect(projects.getProject(a.owner.id, a.id, projectId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    await expect(projects.listProjects(a.owner.id, b.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('duplicate and client contact (FR-PRJ-05, FR-PRJ-03)', () => {
  it('duplicates as a new Draft with its own subdomain and without the contact; idempotent', async () => {
    const ws = await workspaceWith();
    const src = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: 'Wedding Hall',
      category: 'wedding_event',
      city: 'Udaipur',
      contact: { name: 'Client', email: 'c@example.test' },
    });
    await moveTo(ws.owner.id, ws.id, src.id, 'live');
    const k = key();
    const copy = await projects.duplicateProject(ws.owner.id, {
      workspaceId: ws.id,
      projectId: src.id,
      requestKey: k,
    });
    expect(
      (await projects.duplicateProject(ws.owner.id, { workspaceId: ws.id, projectId: src.id, requestKey: k }))
        .id,
    ).toBe(copy.id);
    const d = await projects.getProject(ws.owner.id, ws.id, copy.id);
    const s = await projects.getProject(ws.owner.id, ws.id, src.id);
    expect(d).toMatchObject({
      name: 'Copy of Wedding Hall',
      status: 'draft',
      category: 'wedding_event',
      city: 'Udaipur',
      contact: null,
      duplicatedFrom: { id: src.id, name: 'Wedding Hall' },
    });
    expect(d.health.subdomain?.hostname).not.toBe(s.health.subdomain?.hostname);
    expect(s.status).toBe('live');
  });

  it('saves, updates and removes the contact; no PII in the audit metadata; viewers cannot', async () => {
    const ws = await workspaceWith(['viewer']);
    const { id } = await newProject(ws.owner.id, ws.id);
    const save = (actor: string, contact: { name: string } & Record<string, string>) =>
      projects.saveClientContact(actor, { workspaceId: ws.id, projectId: id, ...contact });
    await save(ws.owner.id, { name: 'Priya', whatsapp: '+91 99999 00000' });
    await save(ws.owner.id, { name: 'Priya', whatsapp: '+91 99999 00000' });
    await save(ws.owner.id, { name: 'Priya K', email: 'priya@example.test' });
    expect((await projects.getProject(ws.owner.id, ws.id, id)).contact).toEqual({
      name: 'Priya K',
      phone: null,
      email: 'priya@example.test',
      whatsapp: null,
    });
    await expect(save(ws.members.viewer!.id, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await projects.removeClientContact(ws.owner.id, { workspaceId: ws.id, projectId: id });
    await projects.removeClientContact(ws.owner.id, { workspaceId: ws.id, projectId: id });
    expect((await projects.getProject(ws.owner.id, ws.id, id)).contact).toBeNull();
    const rows = (await auditRows(ws.owner.id, ws.id)).filter((r) =>
      r.action.startsWith('project.client_contact'),
    );
    expect(rows.map((r) => `${r.action}:${r.result}`)).toEqual([
      'project.client_contact.saved:success',
      'project.client_contact.saved:success',
      'project.client_contact.saved:denied',
      'project.client_contact.removed:success',
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/priya|99999/i);
  });
});

describe('notifications, preferences, outbox and dead letters (FR-NOT-01; S5 D4/D5)', () => {
  it('a review request notifies owners and admins in-app and by e-mail through the outbox', async () => {
    const ws = await teamWorkspace();
    const { id } = await newProject(ws.members.editor!.id, ws.id, 'Review Me');
    await projects.transitionProject(ws.members.editor!.id, {
      workspaceId: ws.id,
      projectId: id,
      from: 'draft',
      to: 'in_review',
    });
    for (const user of [ws.owner, ws.members.admin!]) {
      expect(await notifications.unreadCount(user.id, ws.id)).toBe(1);
      const { items } = await notifications.listNotifications(user.id, ws.id);
      expect(items[0]).toMatchObject({ type: 'project.review_requested', category: 'project.review' });
    }
    expect(await notifications.unreadCount(ws.members.editor!.id, ws.id)).toBe(0);
    await runJobs();
    expect(mail.sent.map((m) => m.to).sort()).toEqual([ws.owner.email, ws.members.admin!.email].sort());
    expect(mail.sent[0]!.subject).toContain('Review requested: Review Me');
    expect(mail.sent[0]!.text).toContain(`${BASE_URL}/w/${ws.slug}/notifications`);
    const owner = await scopeOf(ws.owner.id, ws.id);
    const pending = await db.withTenant(owner, (tx) =>
      tx.outboxEvent.count({ where: { dispatchedAt: null } }),
    );
    expect(pending).toBe(0);

    // Approval notifies the creator (the editor) about the status change.
    await projects.transitionProject(ws.members.admin!.id, {
      workspaceId: ws.id,
      projectId: id,
      from: 'in_review',
      to: 'approved',
    });
    const { items } = await notifications.listNotifications(ws.members.editor!.id, ws.id);
    expect(items[0]).toMatchObject({ type: 'project.status_changed', payload: { to: 'approved' } });
  });

  it('mark read, mark all read, and only the recipient can see or change a notification', async () => {
    const ws = await teamWorkspace();
    for (const n of [1, 2]) {
      const { id } = await newProject(ws.members.editor!.id, ws.id, `P${n}`);
      await projects.transitionProject(ws.members.editor!.id, {
        workspaceId: ws.id,
        projectId: id,
        from: 'draft',
        to: 'in_review',
      });
    }
    const { items } = await notifications.listNotifications(ws.owner.id, ws.id);
    await notifications.markNotificationRead(ws.owner.id, {
      workspaceId: ws.id,
      notificationId: items[0]!.id,
    });
    await notifications.markNotificationRead(ws.owner.id, {
      workspaceId: ws.id,
      notificationId: items[0]!.id,
    });
    expect(await notifications.unreadCount(ws.owner.id, ws.id)).toBe(1);
    await expect(
      notifications.markNotificationRead(ws.members.admin!.id, {
        workspaceId: ws.id,
        notificationId: items[1]!.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await notifications.unreadCount(ws.owner.id, ws.id)).toBe(1);
    expect(await notifications.markAllNotificationsRead(ws.owner.id, { workspaceId: ws.id })).toEqual({
      count: 1,
    });
    expect(await notifications.unreadCount(ws.owner.id, ws.id)).toBe(0);
    expect(await notifications.unreadCount(ws.members.admin!.id, ws.id)).toBe(2);
  });

  it('preferences: in-app off hides the category, e-mail off writes no outbox row, a late opt-out skips the send', async () => {
    const ws = await teamWorkspace();
    const submit = async (n: string) => {
      const { id } = await newProject(ws.members.editor!.id, ws.id, n);
      await projects.transitionProject(ws.members.editor!.id, {
        workspaceId: ws.id,
        projectId: id,
        from: 'draft',
        to: 'in_review',
      });
    };
    expect(await notifications.getPreferences(ws.owner.id, ws.id)).toMatchObject({
      'project.review': { inApp: true, email: true },
      'workspace.members': { inApp: true, email: false },
    });
    await notifications.savePreferences(ws.owner.id, {
      workspaceId: ws.id,
      preferences: {
        'project.review': { inApp: false, email: false },
        'workspace.members': { inApp: true, email: true },
      },
    });
    // workspace.members has no e-mail path: the choice is stored as off.
    expect((await notifications.getPreferences(ws.owner.id, ws.id))['workspace.members'].email).toBe(false);
    await expect(
      notifications.savePreferences(ws.owner.id, {
        workspaceId: ws.id,
        preferences: { 'billing.all': { inApp: true, email: true } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await submit('Quiet');
    await runJobs();
    expect(await notifications.unreadCount(ws.owner.id, ws.id)).toBe(0);
    expect(mail.sent.map((m) => m.to)).toEqual([ws.members.admin!.email]);

    // The admin opts out of e-mail after the outbox row was written: the job re-checks and skips.
    mail.clear();
    await submit('Late opt-out');
    await notifications.savePreferences(ws.members.admin!.id, {
      workspaceId: ws.id,
      preferences: { 'project.review': { inApp: true, email: false } },
    });
    await runJobs();
    expect(mail.sent).toEqual([]);

    // A member can write only their own preferences, even with raw SQL.
    const admin = await scopeOf(ws.members.admin!.id, ws.id);
    expect(
      await db.withTenant(admin, (tx) =>
        tx.notificationPreference.updateMany({ where: { userId: ws.owner.id }, data: { email: true } }),
      ),
    ).toEqual({ count: 0 });
    await expectPgError(
      db.withTenant(admin, (tx) =>
        tx.notificationPreference.create({
          data: { workspaceId: ws.id, userId: ws.owner.id, category: 'project.status' },
        }),
      ),
      '42501',
    );
  });

  it('a lost emit is re-emitted by the sweep; the sweep reads nothing in a request or job context', async () => {
    const ws = await workspaceWith(['editor']);
    let fail = true;
    const tasks: Array<() => Promise<void>> = [];
    const flaky = createInlineJobs(
      {
        invitationEmail: { deliver: async () => 'skipped', deadLetter: async () => undefined },
        notificationEmail: createNotificationEmailHandler({
          db,
          email: mail,
          baseURL: BASE_URL,
          appName: 'Platform',
        }),
        hostCacheInvalidation: hostCacheHandler,
      },
      (task) => void tasks.push(task),
    );
    const flakyOutbox = createOutbox({
      db,
      jobs: {
        ...flaky.emitter,
        async notificationEmailRequested(ids, options) {
          if (fail) throw new Error('network down');
          return flaky.emitter.notificationEmailRequested(ids, options);
        },
      },
    });
    const flakyProjects = createProjectService({ db, outbox: flakyOutbox });
    const { id } = await flakyProjects.createProject(ws.members.editor!.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: 'Lost',
    });
    await flakyProjects.transitionProject(ws.members.editor!.id, {
      workspaceId: ws.id,
      projectId: id,
      from: 'draft',
      to: 'in_review',
    });
    const owner = await scopeOf(ws.owner.id, ws.id);
    const rows = await db.withTenant(owner, (tx) =>
      tx.outboxEvent.findMany({
        where: { dispatchedAt: null },
        select: { id: true, attempts: true, lastError: true },
      }),
    );
    expect(rows).toEqual([{ id: expect.any(String), attempts: 1, lastError: 'network down' }]);

    // While the row is pending: only a context-free (system) transaction sees it through outbox_pending; a request
    // or job transaction gets nothing, not even its own workspace's row.
    const pendingIds = (q: Promise<Array<{ id: string }>>) => q.then((r) => r.map((x) => x.id));
    expect(
      await pendingIds(db.withSystem((tx) => tx.$queryRaw`SELECT id FROM app.outbox_pending(500, 0)`)),
    ).toContain(rows[0]!.id);
    for (const run of [
      db.withTenant(
        owner,
        (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.outbox_pending(500, 0)`,
      ),
      db.withJobTenant(
        ws.id,
        (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.outbox_pending(500, 0)`,
      ),
    ]) {
      expect(await run).toEqual([]);
    }

    // Younger than the sweep's minimum age (60 s): not swept yet. A sweep with no minimum age (what the cron does a
    // minute later) emits it, the mail goes out once and the row is marked dispatched.
    // Other suites may leave older pending rows that this sweep emits; this workspace's row must stay pending.
    await flakyOutbox.sweep();
    expect(
      await db.withTenant(owner, (tx) =>
        tx.outboxEvent.count({ where: { id: rows[0]!.id, dispatchedAt: null } }),
      ),
    ).toBe(1);
    fail = false;
    const eager = createOutbox({ db, jobs: flaky.emitter, sweepMinAgeSeconds: 0 });
    // Other suites leave rows of other workspaces in the shared local database (e.g. unknown test events, which the
    // sweep counts as failed); this workspace's row is what is asserted.
    expect((await eager.sweep()).dispatched).toBeGreaterThanOrEqual(1);
    while (tasks.length) await tasks.shift()!();
    expect(mail.sent.map((m) => m.to)).toEqual([ws.owner.email]);
    expect(await db.withTenant(owner, (tx) => tx.outboxEvent.count({ where: { dispatchedAt: null } }))).toBe(
      0,
    );
  });

  it('a failed delivery is dead-lettered to job_dead_letters, visible to the owner only', async () => {
    const ws = await workspaceWith(['admin', 'editor']);
    const broken = createNotificationEmailHandler({
      db,
      email: {
        name: 'broken',
        async send() {
          throw new Error('provider 500 for priya@example.test');
        },
      },
      baseURL: BASE_URL,
      appName: 'Platform',
    });
    const tasks: Array<() => Promise<void>> = [];
    const jobs = createInlineJobs(
      {
        invitationEmail: { deliver: async () => 'skipped', deadLetter: async () => undefined },
        notificationEmail: broken,
        hostCacheInvalidation: hostCacheHandler,
      },
      (task) => void tasks.push(task),
    );
    const svc = createProjectService({ db, outbox: createOutbox({ db, jobs: jobs.emitter }) });
    const { id } = await svc.createProject(ws.members.editor!.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: 'Dead',
    });
    await svc.transitionProject(ws.members.editor!.id, {
      workspaceId: ws.id,
      projectId: id,
      from: 'draft',
      to: 'in_review',
    });
    while (tasks.length) await tasks.shift()!();
    const letters = await audit.listDeadLetters(ws.owner.id, ws.id);
    expect(letters).toHaveLength(2);
    expect(letters[0]).toMatchObject({ functionId: 'notification-email-v1', targetType: 'notification' });
    expect(JSON.stringify(letters)).not.toContain('priya@example.test');
    await expect(audit.listDeadLetters(ws.members.admin!.id, ws.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const editor = await scopeOf(ws.members.editor!.id, ws.id);
    expect(await db.withTenant(editor, (tx) => tx.jobDeadLetter.count())).toBe(0);
  });
});

describe('audit viewer and export (FR-AUD-01)', () => {
  it('owner only; filters; keyset pages; actor names; formula-safe CSV; the export is audited', async () => {
    const ws = await workspaceWith(['admin']);
    await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: '=HYPERLINK("http://x")',
    });
    for (let i = 0; i < AUDIT_PAGE_SIZE; i++) await newProject(ws.owner.id, ws.id, `Bulk ${i}`);
    await expect(audit.listAuditLog(ws.members.admin!.id, ws.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(audit.exportAuditLog(ws.members.admin!.id, { workspaceId: ws.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const first = await audit.listAuditLog(ws.owner.id, ws.id);
    expect(first.items).toHaveLength(AUDIT_PAGE_SIZE);
    const second = await audit.listAuditLog(ws.owner.id, ws.id, { cursor: first.nextCursor });
    expect(second.items.some((r) => first.items.some((f) => f.id === r.id))).toBe(false);
    const created = await audit.listAuditLog(ws.owner.id, ws.id, { action: 'project.created' });
    expect(created.items.every((r) => r.action === 'project.created' && r.actorName === 'Suite User')).toBe(
      true,
    );
    const denied = await audit.listAuditLog(ws.owner.id, ws.id, { result: 'denied' });
    // The admin's refused export is the only denied row (a refused read is not audited).
    expect(denied.items.map((r) => r.action)).toEqual(['workspace.audit.exported']);
    expect((await audit.listAuditLog(ws.owner.id, ws.id, { from: '2999-01-01' })).items).toEqual([]);

    const exported = await audit.exportAuditLog(ws.owner.id, {
      workspaceId: ws.id,
      filters: { action: 'project.' },
    });
    expect(exported.truncated).toBe(false);
    const lines = exported.csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'created_at,action,result,actor_type,actor_id,actor_name,target_type,target_id,project_id,correlation_id,metadata',
    );
    expect(lines).toHaveLength(exported.rows + 1);
    expect(exported.csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    const after = await audit.listAuditLog(ws.owner.id, ws.id, { action: 'workspace.audit' });
    expect(after.items[0]).toMatchObject({ action: 'workspace.audit.exported', result: 'success' });
    expect(after.items[0]!.metadata).toMatchObject({ rows: exported.rows, action_prefix: 'project.' });
  });
});
