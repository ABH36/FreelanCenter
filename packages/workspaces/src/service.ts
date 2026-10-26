/**
 * Workspace, membership and invitation commands (module 01/02; FR-WS-01/02/03/05 hook, FR-AUTH-05/06/08, SEC-10).
 *
 * Every command takes the actor's user id from the server-side session and a workspace id that came from the
 * browser. The workspace id is only a selector (cross-module contracts): it is turned into a TenantScope by a
 * membership check, the capability is authorized with `authorize()` before any resource lookup, and the
 * mutation and its audit row commit in one transaction under RLS. "Not yours" and "does not exist" give the same
 * NOT_FOUND (IDOR). The database repeats the member-management rules (migration p1_s5_workspaces_rbac).
 */
import { CAPABILITIES, type Capability, type WorkspaceRole, assignableRoles, can } from '@platform/auth/rbac';
import { type TenantDatabase, type TenantScope, type Tx, isUuid, uuidv7 } from '@platform/db';
import type { JobEmitter } from '@platform/jobs';
import type { Logger } from '@platform/logger';
import { z } from 'zod';
import { WorkspaceError, errorCodes, translate } from './errors';
import {
  type CommandResult,
  type CommandSpec,
  correlationId,
  createScopedRunner,
  memberActor,
  parse,
  writeAudit,
} from './scoped';
import { slugProblem } from './slug';
import { type InvitationKey, hashInvitationToken, invitationToken, isWellFormedToken } from './token';

export const INVITATION_TTL_MS = 7 * 86_400_000;
/** Abuse limits (SEC-09): workspaces a user may create per 24 h, invitations a workspace may send per 24 h. */
export const LIMITS = { workspacesPerDay: 5, invitationsPerDay: 50, openInvitations: 50 } as const;

export type AuditAction =
  | 'workspace.created'
  | 'workspace.renamed'
  | 'workspace.deletion.requested'
  | 'workspace.deletion.cancelled'
  | 'workspace.member.role_changed'
  | 'workspace.member.removed'
  | 'workspace.member.left'
  | 'workspace.invitation.created'
  | 'workspace.invitation.revoked'
  | 'workspace.invitation.resent'
  | 'workspace.invitation.link_viewed';

export interface WorkspaceServiceDeps {
  db: TenantDatabase;
  jobs: JobEmitter;
  invitationKey: InvitationKey;
  /** Dashboard origin for invitation links, e.g. https://app.example.com */
  baseURL: string;
  logger?: Logger;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  status: 'active' | 'suspended';
  deletionScheduledFor: Date | null;
}

export interface WorkspaceContext extends WorkspaceSummary {
  scope: TenantScope;
  createdAt: Date;
  /** What the UI may offer; the commands re-check on the server. */
  can: Record<Capability, boolean>;
}

export interface MemberRow {
  membershipId: string;
  userId: string;
  role: WorkspaceRole;
  name: string;
  email: string;
  joinedAt: Date;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: Date;
  createdAt: Date;
  expired: boolean;
}

export type AcceptOutcome = 'accepted' | 'already_member' | 'wrong_account' | 'invalid';

const nameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Enter a name.').max(100, 'Use at most 100 characters.'));
const inviteRoleSchema = z.enum(['admin', 'editor', 'viewer']);
const roleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
const emailSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.email('Enter a valid e-mail address.').max(320));

export function createWorkspaceService(deps: WorkspaceServiceDeps) {
  const { db, logger } = deps;
  const runner = createScopedRunner(db, logger);
  const { query } = runner;
  const command = <T>(
    actorUserId: string,
    workspaceId: unknown,
    spec: CommandSpec & { action: AuditAction },
    fn: (tx: Tx, scope: TenantScope) => Promise<CommandResult<T>>,
  ) => runner.command(actorUserId, workspaceId, spec, fn);

  function invitationUrl(invitationId: string): string {
    return `${deps.baseURL}/invite/${invitationToken(deps.invitationKey, invitationId)}`;
  }

  /** After commit: a lost event leaves the invitation pending, and the UI offers "Resend" (no outbox yet). */
  async function emitInvitation(workspaceId: string, invitationId: string) {
    try {
      await deps.jobs.invitationCreated({ workspaceId, invitationId });
    } catch (error) {
      logger?.error('workspace.invitation.emit_failed', error, { workspaceId, invitationId });
    }
  }

  async function insertInvitation(tx: Tx, scope: TenantScope, email: string, role: WorkspaceRole) {
    const id = uuidv7();
    await tx.invitation.create({
      data: {
        id,
        workspaceId: scope.workspaceId,
        email,
        role,
        tokenHash: hashInvitationToken(invitationToken(deps.invitationKey, id)),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedBy: scope.actorUserId,
      },
      select: { id: true },
    });
    return id;
  }

  async function findMember(tx: Tx, membershipId: unknown) {
    if (typeof membershipId !== 'string' || !isUuid(membershipId)) throw new WorkspaceError('NOT_FOUND');
    const member = await tx.membership.findFirst({
      where: { id: membershipId },
      select: { id: true, userId: true, role: true },
    });
    if (!member) throw new WorkspaceError('NOT_FOUND');
    return member;
  }

  async function findOpenInvitation(tx: Tx, invitationId: unknown) {
    if (typeof invitationId !== 'string' || !isUuid(invitationId)) throw new WorkspaceError('NOT_FOUND');
    const invitation = await tx.invitation.findFirst({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      select: { id: true, email: true, role: true, expiresAt: true },
    });
    if (!invitation) throw new WorkspaceError('NOT_FOUND');
    return invitation;
  }

  return {
    /** Workspaces the actor belongs to (switcher, FR-AUTH-08). */
    async listMyWorkspaces(actorUserId: string): Promise<WorkspaceSummary[]> {
      const rows = await db.withActor(actorUserId, (tx) =>
        tx.membership.findMany({
          where: { userId: actorUserId },
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            workspace: { select: { id: true, name: true, slug: true, status: true, scheduledPurgeAt: true } },
          },
        }),
      );
      return rows.map((r) => ({
        id: r.workspace.id,
        name: r.workspace.name,
        slug: r.workspace.slug,
        role: r.role,
        status: r.workspace.status,
        deletionScheduledFor: r.workspace.scheduledPurgeAt,
      }));
    },

    /** The workspace behind a dashboard route `/w/<slug>` (FR-WS-03), or null when the actor is not a member. */
    async resolveBySlug(actorUserId: string, slug: string): Promise<WorkspaceContext | null> {
      if (slugProblem(slug) === 'format') return null;
      const membership = await db.withActor(actorUserId, (tx) =>
        tx.membership.findFirst({
          where: { userId: actorUserId, workspace: { slug } },
          select: { workspaceId: true },
        }),
      );
      if (!membership) return null;
      const scope = await db.resolveTenantScope(actorUserId, membership.workspaceId);
      if (!scope) return null;
      const w = await db.withTenant(scope, (tx) =>
        tx.workspace.findUniqueOrThrow({
          where: { id: scope.workspaceId },
          select: { id: true, name: true, slug: true, status: true, scheduledPurgeAt: true, createdAt: true },
        }),
      );
      const actor = memberActor(scope);
      const capabilities = Object.fromEntries(
        CAPABILITIES.map((c) => [c, can(actor, c, { workspaceId: w.id })]),
      ) as Record<Capability, boolean>;
      return {
        scope,
        id: w.id,
        name: w.name,
        slug: w.slug,
        role: scope.role,
        status: w.status,
        deletionScheduledFor: w.scheduledPurgeAt,
        createdAt: w.createdAt,
        can: capabilities,
      };
    },

    /** FR-WS-01: unique slug, reserved words blocked; the creator becomes the owner. */
    async createWorkspace(actorUserId: string, input: { name: unknown; slug: unknown }) {
      const name = parse(nameSchema, input.name, 'name');
      const slug = parse(z.string().trim().toLowerCase(), input.slug, 'slug');
      const problem = slugProblem(slug);
      if (problem === 'reserved')
        throw new WorkspaceError('SLUG_RESERVED', { slug: 'That address is reserved.' });
      if (problem) {
        throw new WorkspaceError('INVALID_INPUT', {
          slug: 'Use 3-48 lower-case letters, digits and single hyphens, starting and ending with a letter or digit.',
        });
      }
      const recent = await db.withActor(actorUserId, (tx) =>
        tx.membership.count({
          where: { userId: actorUserId, role: 'owner', createdAt: { gt: new Date(Date.now() - 86_400_000) } },
        }),
      );
      if (recent >= LIMITS.workspacesPerDay) throw new WorkspaceError('RATE_LIMITED');
      try {
        return await db.withNewWorkspace(actorUserId, async (tx, scope) => {
          await tx.workspace.create({
            data: { id: scope.workspaceId, name, slug, createdBy: actorUserId },
            select: { id: true },
          });
          await tx.membership.create({
            data: {
              workspaceId: scope.workspaceId,
              userId: actorUserId,
              role: 'owner',
              createdBy: actorUserId,
            },
            select: { id: true },
          });
          await writeAudit(tx, scope, 'workspace.created', {
            targetType: 'workspace',
            targetId: scope.workspaceId,
            metadata: { slug },
          });
          return { id: scope.workspaceId, slug };
        });
      } catch (error) {
        const codes = errorCodes(error);
        if (codes.includes('P2002') || codes.includes('23505')) {
          throw new WorkspaceError('SLUG_TAKEN', { slug: 'That address is already taken.' });
        }
        return translate(error);
      }
    },

    /** FR-WS-02 usage overview (plan and billing arrive in P6). */
    async getOverview(actorUserId: string, workspaceId: unknown) {
      return query(actorUserId, workspaceId, 'workspace.view', async (tx, scope) => ({
        members: await tx.membership.count({ where: { workspaceId: scope.workspaceId } }),
        projects: await tx.project.count({ where: { deletedAt: null } }),
        openInvitations: can(memberActor(scope), 'members.manage')
          ? await tx.invitation.count({
              where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
            })
          : null,
      }));
    },

    async renameWorkspace(actorUserId: string, input: { workspaceId: unknown; name: unknown }) {
      const name = parse(nameSchema, input.name, 'name');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.renamed', capability: 'workspace.update' },
        async (tx, scope) => {
          await tx.workspace.update({
            where: { id: scope.workspaceId },
            data: { name },
            select: { id: true },
          });
          return { result: undefined, audit: { targetType: 'workspace', targetId: scope.workspaceId } };
        },
      );
    },

    /**
     * FR-WS-05 hook (Q4): schedules deletion after the 30-day grace period. Writes stop at once (RLS); the purge
     * itself is the P8 `retention.sweep` job. Idempotent: a repeat keeps the first schedule.
     */
    async requestDeletion(actorUserId: string, input: { workspaceId: unknown; confirmSlug: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.deletion.requested', capability: 'workspace.delete', requireWritable: false },
        async (tx, scope) => {
          const w = await tx.workspace.findUniqueOrThrow({
            where: { id: scope.workspaceId },
            select: { slug: true, status: true, deletedAt: true, scheduledPurgeAt: true },
          });
          if (w.status !== 'active') throw new WorkspaceError('NOT_WRITABLE');
          if (String(input.confirmSlug ?? '').trim() !== w.slug)
            throw new WorkspaceError('CONFIRMATION_MISMATCH');
          if (w.deletedAt) return { result: { scheduledPurgeAt: w.scheduledPurgeAt as Date }, audit: null };
          // The database sets both dates from its own clock (workspaces_guard).
          const updated = await tx.workspace.update({
            where: { id: scope.workspaceId },
            data: { deletedAt: new Date() },
            select: { scheduledPurgeAt: true },
          });
          const scheduledPurgeAt = updated.scheduledPurgeAt as Date;
          return {
            result: { scheduledPurgeAt },
            audit: {
              targetType: 'workspace',
              targetId: scope.workspaceId,
              metadata: { scheduled_purge_at: scheduledPurgeAt.toISOString() },
            },
          };
        },
      );
    },

    async cancelDeletion(actorUserId: string, input: { workspaceId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.deletion.cancelled', capability: 'workspace.delete', requireWritable: false },
        async (tx, scope) => {
          const w = await tx.workspace.findUniqueOrThrow({
            where: { id: scope.workspaceId },
            select: { status: true, deletedAt: true },
          });
          if (!w.deletedAt) return { result: undefined, audit: null };
          if (w.status !== 'active') throw new WorkspaceError('NOT_WRITABLE');
          await tx.workspace.update({
            where: { id: scope.workspaceId },
            data: { deletedAt: null },
            select: { id: true },
          });
          return { result: undefined, audit: { targetType: 'workspace', targetId: scope.workspaceId } };
        },
      );
    },

    async listMembers(actorUserId: string, workspaceId: unknown): Promise<MemberRow[]> {
      return query(actorUserId, workspaceId, 'members.view', async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            membership_id: string;
            user_id: string;
            role: WorkspaceRole;
            name: string;
            email: string;
            joined_at: Date;
          }>
        >`SELECT membership_id, user_id, role, name, email, joined_at FROM app.workspace_members()`;
        return rows.map((r) => ({
          membershipId: r.membership_id,
          userId: r.user_id,
          role: r.role,
          name: r.name,
          email: r.email,
          joinedAt: r.joined_at,
        }));
      });
    },

    /** Owners manage every role; admins every role except owner (SRS 7; enforced again by memberships_guard). */
    async changeMemberRole(
      actorUserId: string,
      input: { workspaceId: unknown; membershipId: unknown; role: unknown },
    ) {
      const role = parse(roleSchema, input.role, 'role');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.member.role_changed', capability: 'members.manage' },
        async (tx, scope) => {
          const member = await findMember(tx, input.membershipId);
          if (member.role === role) return { result: undefined, audit: null };
          if (
            (member.role === 'owner' || role === 'owner') &&
            !assignableRoles(scope.role).includes('owner')
          ) {
            throw new WorkspaceError('FORBIDDEN');
          }
          await tx.membership.update({ where: { id: member.id }, data: { role }, select: { id: true } });
          return {
            result: undefined,
            audit: {
              targetType: 'membership',
              targetId: member.id,
              metadata: { user_id: member.userId, from: member.role, to: role },
            },
          };
        },
      );
    },

    async removeMember(actorUserId: string, input: { workspaceId: unknown; membershipId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.member.removed', capability: 'members.manage' },
        async (tx, scope) => {
          const member = await findMember(tx, input.membershipId);
          if (member.role === 'owner' && scope.role !== 'owner') throw new WorkspaceError('FORBIDDEN');
          await tx.membership.delete({ where: { id: member.id }, select: { id: true } });
          return {
            result: undefined,
            audit: {
              targetType: 'membership',
              targetId: member.id,
              metadata: { user_id: member.userId, role: member.role },
            },
          };
        },
      );
    },

    /** Any member may leave; the last owner may not (LAST_OWNER). */
    async leaveWorkspace(actorUserId: string, input: { workspaceId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.member.left', capability: 'workspace.view' },
        async (tx, scope) => {
          const own = await tx.membership.findFirstOrThrow({
            where: { workspaceId: scope.workspaceId, userId: scope.actorUserId },
            select: { id: true, role: true },
          });
          await tx.membership.delete({ where: { id: own.id }, select: { id: true } });
          return {
            result: undefined,
            audit: { targetType: 'membership', targetId: own.id, metadata: { role: own.role } },
          };
        },
      );
    },

    /** Open invitations, managers only (they show addresses of people who are not members). */
    async listInvitations(actorUserId: string, workspaceId: unknown): Promise<InvitationRow[]> {
      return query(actorUserId, workspaceId, 'members.manage', async (tx) => {
        const rows = await tx.invitation.findMany({
          where: { acceptedAt: null, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          take: LIMITS.openInvitations,
          select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        });
        const now = Date.now();
        return rows.map((r) => ({ ...r, expired: r.expiresAt.getTime() <= now }));
      });
    },

    /** FR-AUTH-06: hashed token, 7-day expiry, e-mail through the job (FR-NOT-01). */
    async createInvitation(
      actorUserId: string,
      input: { workspaceId: unknown; email: unknown; role: unknown },
    ) {
      const email = parse(emailSchema, input.email, 'email');
      const role = parse(inviteRoleSchema, input.role, 'role');
      const created = await command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.invitation.created', capability: 'members.manage' },
        async (tx, scope) => {
          if (!assignableRoles(scope.role).includes(role)) throw new WorkspaceError('FORBIDDEN');
          const members = await tx.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM app.workspace_members() WHERE email = ${email}`;
          if ((members[0]?.n ?? 0) > 0)
            throw new WorkspaceError('ALREADY_MEMBER', { email: 'Already a member.' });
          const since = new Date(Date.now() - 86_400_000);
          if (
            (await tx.invitation.count({ where: { createdAt: { gt: since } } })) >= LIMITS.invitationsPerDay
          ) {
            throw new WorkspaceError('RATE_LIMITED');
          }
          const open = await tx.invitation.findFirst({
            where: { email, acceptedAt: null, revokedAt: null },
            select: { id: true, expiresAt: true },
          });
          if (open && open.expiresAt.getTime() > Date.now()) {
            throw new WorkspaceError('ALREADY_INVITED', { email: 'Already invited.' });
          }
          // An expired invitation still holds the one-open-per-address slot: close it first.
          if (open)
            await tx.invitation.updateMany({ where: { id: open.id }, data: { revokedAt: new Date() } });
          const id = await insertInvitation(tx, scope, email, role);
          return {
            result: { invitationId: id, workspaceId: scope.workspaceId },
            audit: { targetType: 'invitation', targetId: id, metadata: { role } },
          };
        },
      );
      await emitInvitation(created.workspaceId, created.invitationId);
      return { invitationId: created.invitationId };
    },

    async revokeInvitation(actorUserId: string, input: { workspaceId: unknown; invitationId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.invitation.revoked', capability: 'members.manage' },
        async (tx) => {
          const invitation = await findOpenInvitation(tx, input.invitationId);
          await tx.invitation.updateMany({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
          return { result: undefined, audit: { targetType: 'invitation', targetId: invitation.id } };
        },
      );
    },

    /** Re-issue: the old link stops working, a new token and expiry are mailed. */
    async resendInvitation(actorUserId: string, input: { workspaceId: unknown; invitationId: unknown }) {
      const resent = await command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.invitation.resent', capability: 'members.manage' },
        async (tx, scope) => {
          const old = await findOpenInvitation(tx, input.invitationId);
          if (!assignableRoles(scope.role).includes(old.role)) throw new WorkspaceError('FORBIDDEN');
          await tx.invitation.updateMany({ where: { id: old.id }, data: { revokedAt: new Date() } });
          const id = await insertInvitation(tx, scope, old.email, old.role);
          return {
            result: { invitationId: id, workspaceId: scope.workspaceId },
            audit: { targetType: 'invitation', targetId: id, metadata: { previous_invitation_id: old.id } },
          };
        },
      );
      await emitInvitation(resent.workspaceId, resent.invitationId);
      return { invitationId: resent.invitationId };
    },

    /** The accept link for a manager to share by hand (no real e-mail before DG-10). Audited: it is a credential. */
    async invitationLink(actorUserId: string, input: { workspaceId: unknown; invitationId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.invitation.link_viewed', capability: 'members.manage' },
        async (tx) => {
          const invitation = await findOpenInvitation(tx, input.invitationId);
          if (invitation.expiresAt.getTime() <= Date.now()) throw new WorkspaceError('NOT_FOUND');
          return {
            result: { url: invitationUrl(invitation.id) },
            audit: { targetType: 'invitation', targetId: invitation.id },
          };
        },
      );
    },

    /** What `/invite/<token>` shows a signed-in user before accepting. null = unknown, used, expired or revoked. */
    async previewInvitation(actorUserId: string, token: string) {
      if (!isWellFormedToken(token)) return null;
      const rows = await db.withActor(
        actorUserId,
        (tx) =>
          tx.$queryRaw<
            Array<{ workspace_name: string; role: WorkspaceRole; email_hint: string; expires_at: Date }>
          >`
          SELECT workspace_name, role, email_hint, expires_at FROM app.invitation_preview(${hashInvitationToken(token)})`,
      );
      const row = rows[0];
      return row
        ? {
            workspaceName: row.workspace_name,
            role: row.role,
            emailHint: row.email_hint,
            expiresAt: row.expires_at,
          }
        : null;
    },

    /** Accept-once through `app.accept_invitation` (definer). Safe to repeat and to race. */
    async acceptInvitation(
      actorUserId: string,
      token: string,
    ): Promise<{ outcome: AcceptOutcome; slug: string | null }> {
      if (!isWellFormedToken(token)) return { outcome: 'invalid', slug: null };
      const rows = await db.withActor(
        actorUserId,
        (tx) =>
          tx.$queryRaw<Array<{ outcome: AcceptOutcome; workspace_slug: string | null }>>`
          SELECT outcome, workspace_slug FROM app.accept_invitation(${hashInvitationToken(token)}, ${correlationId()})`,
      );
      const row = rows[0] ?? { outcome: 'invalid' as const, workspace_slug: null };
      logger?.info('workspace.invitation.accept', { outcome: row.outcome });
      return { outcome: row.outcome, slug: row.workspace_slug };
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
