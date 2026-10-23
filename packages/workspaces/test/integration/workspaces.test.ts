/**
 * Workspace, membership and invitation commands against the real database (FR-WS-01/02/03/05 hook,
 * FR-AUTH-05/06/08, SEC-10). Each RLS rule added by migration p1_s5_workspaces_rbac is proven twice: through the
 * service (typed outcome) and with raw SQL as app_user (the database refuses even when a service is bypassed).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { TenantScope } from '@platform/db';
import { expectPgError } from '@platform/db/testing';
import { RESERVED_SLUGS, slugify, slugProblem } from '../../src/slug';
import { hashInvitationToken, invitationToken } from '../../src/token';
import { LIMITS } from '../../src/service';
import {
  BASE_URL,
  auth,
  closeAll,
  createUser,
  db,
  handler,
  invitationKey,
  mail,
  runJobs,
  service,
  unique,
  workspaceWith,
} from '../harness';

afterAll(closeAll);

const scopeOf = async (userId: string, workspaceId: string): Promise<TenantScope> =>
  (await db.resolveTenantScope(userId, workspaceId))!;

async function auditActions(ownerId: string, workspaceId: string) {
  return db.withTenant(await scopeOf(ownerId, workspaceId), (tx) =>
    tx.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
      select: { action: true, result: true, actorId: true, actorType: true, targetId: true, metadata: true },
    }),
  );
}

const tokenOf = (url: string) => url.split('/invite/')[1]!;

describe('slugs (FR-WS-01, FR-WS-03)', () => {
  it('the TypeScript reserved list equals app.reserved_slugs()', async () => {
    const owner = await createUser();
    const rows = await db.withActor(
      owner.id,
      (tx) => tx.$queryRaw<Array<{ s: string[] }>>`SELECT app.reserved_slugs() AS s`,
    );
    expect([...rows[0]!.s].sort()).toEqual([...RESERVED_SLUGS].sort());
    for (const slug of RESERVED_SLUGS) expect(slugProblem(slug), slug).not.toBe('format');
  });

  it('rejects reserved, malformed and taken slugs with typed errors', async () => {
    const owner = await createUser();
    await expect(service.createWorkspace(owner.id, { name: 'A', slug: 'admin' })).rejects.toMatchObject({
      code: 'SLUG_RESERVED',
    });
    for (const slug of ['ab', '-abc', 'abc-', 'a--b', 'Has Space', 'x'.repeat(49)]) {
      await expect(service.createWorkspace(owner.id, { name: 'A', slug }), slug).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    const slug = unique('taken');
    await service.createWorkspace(owner.id, { name: 'First', slug });
    const other = await createUser();
    await expect(service.createWorkspace(other.id, { name: 'Second', slug })).rejects.toMatchObject({
      code: 'SLUG_TAKEN',
    });
  });

  it('the database refuses a reserved slug even when the service is bypassed', async () => {
    const owner = await createUser();
    await expectPgError(
      db.withNewWorkspace(owner.id, (tx, scope) =>
        tx.workspace.create({ data: { id: scope.workspaceId, name: 'x', slug: 'www' } }),
      ),
      '23514',
    );
  });

  it('slugify proposes valid slugs', () => {
    expect(slugify('Sharma Taxi Services')).toBe('sharma-taxi-services');
    expect(slugify('Café Été')).toBe('cafe-ete');
    expect(slugProblem(slugify('!!'))).toBeNull();
    expect(slugProblem(slugify('x'.repeat(80)))).toBeNull();
  });
});

describe('create, list, switch (FR-WS-01, FR-AUTH-08)', () => {
  it('the creator becomes owner, the workspace is listed and resolvable by slug, with an audit row', async () => {
    const owner = await createUser();
    const { id, slug } = await service.createWorkspace(owner.id, {
      name: '  Sharma   Taxi ',
      slug: unique('sharma'),
    });
    const mine = await service.listMyWorkspaces(owner.id);
    expect(mine).toContainEqual(
      expect.objectContaining({ id, slug, name: 'Sharma Taxi', role: 'owner', status: 'active' }),
    );
    const ctx = await service.resolveBySlug(owner.id, slug);
    expect(ctx).toMatchObject({
      id,
      role: 'owner',
      can: { 'workspace.delete': true, 'members.manage': true },
    });
    expect(await auditActions(owner.id, id)).toEqual([
      expect.objectContaining({ action: 'workspace.created', result: 'success', actorId: owner.id }),
    ]);
  });

  it('a non-member resolves nothing by slug and gets NOT_FOUND by id (same as an unknown id)', async () => {
    const w = await workspaceWith();
    const stranger = await createUser();
    expect(await service.resolveBySlug(stranger.id, w.slug)).toBeNull();
    expect(await service.listMyWorkspaces(stranger.id)).toEqual([]);
    for (const id of [w.id, '01900000-0000-7000-8000-00000000dead', 'not-a-uuid']) {
      await expect(
        service.renameWorkspace(stranger.id, { workspaceId: id, name: 'x' }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.listMembers(stranger.id, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it(`a user may create at most ${LIMITS.workspacesPerDay} workspaces per day`, async () => {
    const owner = await createUser();
    for (let i = 0; i < LIMITS.workspacesPerDay; i += 1) {
      await service.createWorkspace(owner.id, { name: `W${i}`, slug: unique('limit') });
    }
    await expect(
      service.createWorkspace(owner.id, { name: 'One more', slug: unique('limit') }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('settings and deletion request (FR-WS-02, FR-WS-05 hook)', () => {
  it('owners and admins rename; editors and viewers are refused, and the refusal is audited', async () => {
    const w = await workspaceWith(['admin', 'editor', 'viewer']);
    await service.renameWorkspace(w.members.admin!.id, { workspaceId: w.id, name: 'Renamed by admin' });
    for (const role of ['editor', 'viewer'] as const) {
      await expect(
        service.renameWorkspace(w.members[role]!.id, { workspaceId: w.id, name: 'x' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const trail = await auditActions(w.owner.id, w.id);
    expect(trail.filter((a) => a.action === 'workspace.renamed').map((a) => a.result)).toEqual([
      'success',
      'denied',
      'denied',
    ]);
    // RLS: an editor's raw UPDATE matches no row.
    const editorScope = await scopeOf(w.members.editor!.id, w.id);
    expect(
      await db.withTenant(editorScope, (tx) => tx.$executeRaw`UPDATE app.workspaces SET name = 'raw'`),
    ).toBe(0);
  });

  it('only the owner schedules deletion; dates come from the database; writes stop; cancel restores', async () => {
    const w = await workspaceWith(['admin']);
    await expect(
      service.requestDeletion(w.members.admin!.id, { workspaceId: w.id, confirmSlug: w.slug }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.requestDeletion(w.owner.id, { workspaceId: w.id, confirmSlug: 'nope' }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    });
    const { scheduledPurgeAt } = await service.requestDeletion(w.owner.id, {
      workspaceId: w.id,
      confirmSlug: w.slug,
    });
    const days = (scheduledPurgeAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30.01);
    // Idempotent: the first schedule stays.
    expect(
      (await service.requestDeletion(w.owner.id, { workspaceId: w.id, confirmSlug: w.slug }))
        .scheduledPurgeAt,
    ).toEqual(scheduledPurgeAt);
    expect((await scopeOf(w.owner.id, w.id)).writable).toBe(false);
    await expect(service.renameWorkspace(w.owner.id, { workspaceId: w.id, name: 'x' })).rejects.toMatchObject(
      {
        code: 'NOT_WRITABLE',
      },
    );
    await expect(
      service.createInvitation(w.owner.id, { workspaceId: w.id, email: 'late@example.test', role: 'editor' }),
    ).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
    // An admin cannot cancel either (owner-only), even with raw SQL.
    await expectPgError(
      db.withTenant(
        await scopeOf(w.members.admin!.id, w.id),
        (tx) => tx.$executeRaw`UPDATE app.workspaces SET deleted_at = NULL, scheduled_purge_at = NULL`,
      ),
      '42501',
    );
    await service.cancelDeletion(w.owner.id, { workspaceId: w.id });
    expect((await scopeOf(w.owner.id, w.id)).writable).toBe(true);
    const actions = (await auditActions(w.owner.id, w.id)).map((a) => `${a.action}:${a.result}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'workspace.deletion.requested:denied',
        'workspace.deletion.requested:success',
        'workspace.deletion.cancelled:success',
      ]),
    );
    expect(actions.filter((a) => a === 'workspace.deletion.requested:success')).toHaveLength(1);
  });

  it('the owner cannot back-date a purge: the trigger overrides caller-supplied dates', async () => {
    const w = await workspaceWith();
    const rows = await db.withTenant(
      await scopeOf(w.owner.id, w.id),
      (tx) =>
        tx.$queryRaw<Array<{ purge_days: number }>>`
        UPDATE app.workspaces SET deleted_at = now() - interval '60 days', scheduled_purge_at = now() - interval '1 day'
        RETURNING extract(epoch FROM scheduled_purge_at - now()) / 86400 AS purge_days`,
    );
    expect(Number(rows[0]!.purge_days)).toBeCloseTo(30, 1);
  });
});

describe('members and roles (SRS 7, last-owner protection)', () => {
  it('admins manage non-owners; only owners touch the owner role', async () => {
    const w = await workspaceWith(['admin', 'editor', 'viewer']);
    const admin = w.members.admin!;
    await service.changeMemberRole(admin.id, {
      workspaceId: w.id,
      membershipId: w.members.viewer!.membershipId,
      role: 'editor',
    });
    await expect(
      service.changeMemberRole(admin.id, {
        workspaceId: w.id,
        membershipId: w.members.editor!.membershipId,
        role: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.changeMemberRole(admin.id, {
        workspaceId: w.id,
        membershipId: w.owner.membershipId,
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.removeMember(admin.id, { workspaceId: w.id, membershipId: w.owner.membershipId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const role of ['editor', 'viewer'] as const) {
      await expect(
        service.changeMemberRole(w.members[role]!.id, {
          workspaceId: w.id,
          membershipId: w.members.admin!.membershipId,
          role: 'viewer',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.createInvitation(w.members[role]!.id, {
          workspaceId: w.id,
          email: 'x@example.test',
          role: 'viewer',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // Ownership transfer by the owner.
    await service.changeMemberRole(w.owner.id, {
      workspaceId: w.id,
      membershipId: admin.membershipId,
      role: 'owner',
    });
    await service.changeMemberRole(w.owner.id, {
      workspaceId: w.id,
      membershipId: w.owner.membershipId,
      role: 'admin',
    });
    const roles = Object.fromEntries(
      (await service.listMembers(admin.id, w.id)).map((m) => [m.userId, m.role]),
    );
    expect(roles[admin.id]).toBe('owner');
    expect(roles[w.owner.id]).toBe('admin');
    const changes = (await auditActions(admin.id, w.id)).filter(
      (a) => a.action === 'workspace.member.role_changed',
    );
    expect(changes.map((c) => c.result)).toEqual(expect.arrayContaining(['success', 'denied']));
    expect(changes.find((c) => c.result === 'success')?.metadata).toMatchObject({
      from: 'viewer',
      to: 'editor',
    });
  });

  it('the database refuses the same escalations with raw SQL (memberships_guard and role-aware policies)', async () => {
    const w = await workspaceWith(['admin', 'editor']);
    const adminScope = await scopeOf(w.members.admin!.id, w.id);
    const editorScope = await scopeOf(w.members.editor!.id, w.id);
    // Editor: no membership write matches (policy), not even on their own row.
    expect(
      await db.withTenant(editorScope, (tx) => tx.$executeRaw`UPDATE app.memberships SET role = 'admin'`),
    ).toBe(0);
    expect(
      await db.withTenant(
        editorScope,
        (tx) => tx.$executeRaw`DELETE FROM app.memberships WHERE id = ${w.members.admin!.membershipId}::uuid`,
      ),
    ).toBe(0);
    // Admin: promoting to owner, demoting or removing an owner raise 42501 (trigger).
    await expectPgError(
      db.withTenant(
        adminScope,
        (tx) =>
          tx.$executeRaw`UPDATE app.memberships SET role = 'owner' WHERE id = ${w.members.editor!.membershipId}::uuid`,
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(
        adminScope,
        (tx) => tx.$executeRaw`DELETE FROM app.memberships WHERE id = ${w.owner.membershipId}::uuid`,
      ),
      '42501',
    );
    const newcomer = await createUser();
    await expectPgError(
      db.withTenant(adminScope, (tx) =>
        tx.membership.create({ data: { workspaceId: w.id, userId: newcomer.id, role: 'owner' } }),
      ),
      '42501',
    );
    // A job scope (no actor) cannot add members at all.
    await expectPgError(
      db.withJobTenant(w.id, (tx) =>
        tx.membership.create({ data: { workspaceId: w.id, userId: newcomer.id, role: 'viewer' } }),
      ),
      '42501',
    );
  });

  it('the last owner can neither leave, be removed nor be demoted', async () => {
    const w = await workspaceWith(['admin']);
    await expect(service.leaveWorkspace(w.owner.id, { workspaceId: w.id })).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
    await expect(
      service.changeMemberRole(w.owner.id, {
        workspaceId: w.id,
        membershipId: w.owner.membershipId,
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await expect(
      service.removeMember(w.owner.id, { workspaceId: w.id, membershipId: w.owner.membershipId }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    expect((await service.listMembers(w.owner.id, w.id)).find((m) => m.userId === w.owner.id)?.role).toBe(
      'owner',
    );
    // Non-owners leave freely and lose access at once.
    await service.leaveWorkspace(w.members.admin!.id, { workspaceId: w.id });
    expect(await service.resolveBySlug(w.members.admin!.id, w.slug)).toBeNull();
  });

  it('two owners demoting each other at the same moment: exactly one succeeds (race)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const w = await workspaceWith(['admin']);
      const second = w.members.admin!;
      await service.changeMemberRole(w.owner.id, {
        workspaceId: w.id,
        membershipId: second.membershipId,
        role: 'owner',
      });
      const results = await Promise.allSettled([
        service.changeMemberRole(w.owner.id, {
          workspaceId: w.id,
          membershipId: second.membershipId,
          role: 'admin',
        }),
        service.changeMemberRole(second.id, {
          workspaceId: w.id,
          membershipId: w.owner.membershipId,
          role: 'admin',
        }),
      ]);
      const outcomes = results.map((r) =>
        r.status === 'fulfilled' ? 'ok' : (r.reason as { code: string }).code,
      );
      // Either one demotion wins and the other hits LAST_OWNER, or the loser lost its owner role first (FORBIDDEN).
      expect(
        outcomes.filter((o) => o === 'ok'),
        `round ${round}: ${outcomes.join(',')}`,
      ).toHaveLength(1);
      expect(['LAST_OWNER', 'FORBIDDEN']).toContain(outcomes.find((o) => o !== 'ok'));
      const owners = (
        await service.listMembers(w.owner.id, w.id).catch(() => service.listMembers(second.id, w.id))
      ).filter((m) => m.role === 'owner');
      expect(owners).toHaveLength(1);
    }
  });

  it('member directory: names and addresses only for members of the current workspace', async () => {
    const w = await workspaceWith(['viewer']);
    const viewerList = await service.listMembers(w.members.viewer!.id, w.id);
    expect(viewerList.map((m) => m.email).sort()).toEqual([w.owner.email, w.members.viewer!.email].sort());
    const stranger = await createUser();
    const rows = await db.withActor(
      stranger.id,
      (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM app.workspace_members()`,
    );
    expect(rows).toEqual([]);
    expect(
      await db.withJobTenant(w.id, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM app.workspace_members()`),
    ).toEqual([]);
  });
});

describe('invitations (FR-AUTH-06, FR-NOT-01, SEC-11)', () => {
  it('invite -> job sends the mail -> preview -> accept once; inviter notified; audit trail', async () => {
    const w = await workspaceWith();
    const invitee = await createUser();
    const { invitationId } = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email: `  ${invitee.email.toUpperCase()} `,
      role: 'editor',
    });
    // Only the hash is stored, and it is the hash of the derived token.
    const stored = await db.withTenant(await scopeOf(w.owner.id, w.id), (tx) =>
      tx.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { tokenHash: true, email: true },
      }),
    );
    const token = invitationToken(invitationKey, invitationId);
    expect(stored).toEqual({ tokenHash: hashInvitationToken(token), email: invitee.email });
    expect(stored.tokenHash).not.toContain(token);

    await runJobs();
    const sent = mail.sent.filter((m) => m.to === invitee.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('workspace.invitation');
    expect(sent[0]!.text).toContain(`${BASE_URL}/invite/${token}`);
    expect(sent[0]!.html).not.toContain('<script');

    const preview = await service.previewInvitation(invitee.id, token);
    expect(preview).toMatchObject({ workspaceName: 'Suite Workspace', role: 'editor' });
    expect(preview!.emailHint).toMatch(/^w\*\*\*@example\.test$/);

    expect(await service.acceptInvitation(invitee.id, token)).toEqual({ outcome: 'accepted', slug: w.slug });
    expect(await service.acceptInvitation(invitee.id, token)).toEqual({ outcome: 'invalid', slug: null });
    expect(await service.previewInvitation(invitee.id, token)).toBeNull();
    const ctx = await service.resolveBySlug(invitee.id, w.slug);
    expect(ctx?.role).toBe('editor');

    const inbox = await db.withTenant(await scopeOf(w.owner.id, w.id), (tx) =>
      tx.notification.findMany({ select: { type: true, payload: true } }),
    );
    expect(inbox).toContainEqual({
      type: 'workspace.invitation_accepted',
      payload: { invitationId, memberUserId: invitee.id },
    });
    const trail = await auditActions(w.owner.id, w.id);
    expect(trail.map((a) => a.action)).toEqual(
      expect.arrayContaining(['workspace.invitation.created', 'workspace.invitation.accepted']),
    );
    // Audit metadata never carries the address or the token.
    expect(JSON.stringify(trail)).not.toContain('@');
    expect(JSON.stringify(trail)).not.toContain(token);
  });

  it('accept-once under a race: 12 concurrent acceptances, one membership', async () => {
    const w = await workspaceWith();
    const invitee = await createUser();
    const { invitationId } = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email: invitee.email,
      role: 'viewer',
    });
    const token = invitationToken(invitationKey, invitationId);
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => service.acceptInvitation(invitee.id, token)),
    );
    expect(outcomes.filter((o) => o.outcome === 'accepted')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome !== 'accepted').every((o) => o.outcome === 'invalid')).toBe(true);
    const members = await service.listMembers(w.owner.id, w.id);
    expect(members.filter((m) => m.userId === invitee.id)).toHaveLength(1);
    const accepted = (await auditActions(w.owner.id, w.id)).filter(
      (a) => a.action === 'workspace.invitation.accepted',
    );
    expect(accepted).toHaveLength(1);
  });

  it('wrong account, unverified account, revoked, expired, re-issued and malformed tokens', async () => {
    const w = await workspaceWith();
    const invitee = await createUser();
    const other = await createUser();
    const { invitationId } = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email: invitee.email,
      role: 'viewer',
    });
    const token = invitationToken(invitationKey, invitationId);
    expect((await service.acceptInvitation(other.id, token)).outcome).toBe('wrong_account');

    const unverified = await createUser({ verified: false });
    await expectPgError(service.acceptInvitation(unverified.id, token), '42501');

    // Re-issue: the old link dies, the new one works.
    const { invitationId: reissued } = await service.resendInvitation(w.owner.id, {
      workspaceId: w.id,
      invitationId,
    });
    expect((await service.acceptInvitation(invitee.id, token)).outcome).toBe('invalid');
    const { url } = await service.invitationLink(w.owner.id, { workspaceId: w.id, invitationId: reissued });
    await service.revokeInvitation(w.owner.id, { workspaceId: w.id, invitationId: reissued });
    expect((await service.acceptInvitation(invitee.id, tokenOf(url))).outcome).toBe('invalid');

    // Expired: inserted directly with a past expiry by the owner.
    const expiredId = '01900000-0000-7000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
    const expiredToken = invitationToken(invitationKey, expiredId);
    await db.withTenant(await scopeOf(w.owner.id, w.id), (tx) =>
      tx.invitation.create({
        data: {
          id: expiredId,
          workspaceId: w.id,
          email: invitee.email,
          role: 'viewer',
          tokenHash: hashInvitationToken(expiredToken),
          createdAt: new Date(Date.now() - 8 * 86_400_000),
          expiresAt: new Date(Date.now() - 86_400_000),
          invitedBy: w.owner.id,
        },
      }),
    );
    expect((await service.acceptInvitation(invitee.id, expiredToken)).outcome).toBe('invalid');
    expect(await service.previewInvitation(invitee.id, expiredToken)).toBeNull();
    // ...and it does not block a fresh invitation to the same address.
    const fresh = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email: invitee.email,
      role: 'viewer',
    });
    expect(
      (await service.acceptInvitation(invitee.id, invitationToken(invitationKey, fresh.invitationId)))
        .outcome,
    ).toBe('accepted');

    for (const bad of ['', 'short', 'x'.repeat(43) + '!', 'a'.repeat(200)]) {
      expect((await service.acceptInvitation(invitee.id, bad)).outcome).toBe('invalid');
    }
  });

  it('duplicates, existing members, owner role and the deletion window are refused', async () => {
    const w = await workspaceWith(['admin']);
    const email = `${unique('dup')}@example.test`;
    await service.createInvitation(w.owner.id, { workspaceId: w.id, email, role: 'viewer' });
    await expect(
      service.createInvitation(w.owner.id, { workspaceId: w.id, email, role: 'viewer' }),
    ).rejects.toMatchObject({
      code: 'ALREADY_INVITED',
    });
    await expect(
      service.createInvitation(w.owner.id, {
        workspaceId: w.id,
        email: w.members.admin!.email,
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
    await expect(
      service.createInvitation(w.owner.id, { workspaceId: w.id, email: 'x@example.test', role: 'owner' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.createInvitation(w.owner.id, { workspaceId: w.id, email: 'not-an-address', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', fieldErrors: { email: expect.any(String) } });

    // An open invitation cannot be accepted once deletion is scheduled.
    const invitee = await createUser();
    const { invitationId } = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email: invitee.email,
      role: 'viewer',
    });
    await service.requestDeletion(w.owner.id, { workspaceId: w.id, confirmSlug: w.slug });
    expect(
      (await service.acceptInvitation(invitee.id, invitationToken(invitationKey, invitationId))).outcome,
    ).toBe('invalid');
  });

  it('only managers see invitations and links; viewers get FORBIDDEN', async () => {
    const w = await workspaceWith(['viewer']);
    const { invitationId } = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email: `${unique('see')}@example.test`,
      role: 'viewer',
    });
    expect((await service.listInvitations(w.owner.id, w.id)).map((i) => i.id)).toContain(invitationId);
    await expect(service.listInvitations(w.members.viewer!.id, w.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      service.invitationLink(w.members.viewer!.id, { workspaceId: w.id, invitationId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('invitation e-mail job (ADR-007)', () => {
  it('skips an invitation that is no longer open, and sends at most once per invitation', async () => {
    const w = await workspaceWith();
    const email = `${unique('job')}@example.test`;
    const { invitationId } = await service.createInvitation(w.owner.id, {
      workspaceId: w.id,
      email,
      role: 'viewer',
    });
    await service.revokeInvitation(w.owner.id, { workspaceId: w.id, invitationId });
    await runJobs();
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(0);
    expect(await handler.deliver({ workspaceId: w.id, invitationId })).toBe('skipped');
    // A foreign workspace id finds nothing (RLS) and is skipped, never sent.
    const other = await workspaceWith();
    expect(await handler.deliver({ workspaceId: other.id, invitationId })).toBe('skipped');
  });

  it('a dead letter is a durable, workspace-scoped audit row without personal data', async () => {
    const w = await workspaceWith();
    const invitationId = '01900000-0000-7000-8000-00000000beef';
    await handler.deadLetter({
      ids: { workspaceId: w.id, invitationId },
      functionId: 'invitation-email-v1',
      runId: 'run-1',
      error: 'resend rejected the message (422): bad address someone@example.test',
    });
    const row = (await auditActions(w.owner.id, w.id)).find(
      (a) => a.action === 'jobs.invitation_email.dead_lettered',
    );
    expect(row).toMatchObject({ actorType: 'job', result: 'failure', targetId: invitationId });
    expect(JSON.stringify(row)).not.toContain('someone@example.test');
  });
});

describe('identity is untouched', () => {
  it('app_user still cannot read identity.users', async () => {
    await expect(auth.query('SELECT 1')).resolves.toBeTruthy();
    const owner = await createUser();
    await expectPgError(
      db.withActor(owner.id, (tx) => tx.$queryRaw`SELECT email FROM identity.users LIMIT 1`),
      '42501',
    );
  });
});
