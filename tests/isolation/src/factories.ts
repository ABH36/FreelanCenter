/**
 * Row-factory registry (SEC-02). Every relation in a product schema must be classified here: either as a tenant
 * table with a factory and its expected app_user behaviour, or as a non-tenant relation with the reason it holds
 * no tenant data. `registry.test.ts` fails CI when a migration adds a relation that is in neither list, so a new
 * tenant table cannot ship without entering the matrix in `matrix.test.ts` and the IDOR harness.
 *
 * Adding a tenant table: add an entry to TENANT_TABLES (keep the expectations honest: they are asserted), then
 * run `pnpm --filter @platform/isolation-tests test:isolation`.
 */
import { randomBytes } from 'node:crypto';
import type { Tx } from '@platform/db';

export interface FactoryContext {
  /** The workspace the rows belong to. In the cross-tenant INSERT check this is the victim's id. */
  workspaceId: string;
  /** An owner member of that workspace (a valid actor, recipient or inviter there). */
  ownerId: string;
  unique(prefix: string): string;
  /** Creates an identity user through app_auth (outside the tenant transaction). */
  createUser(): Promise<string>;
}

/** Parent rows a factory needs, created in the context's workspace. */
export type Deps = Record<string, string>;

/** The subset of a Prisma model delegate the IDOR harness probes, keyed by primary key `id`. */
export interface IdDelegate {
  findUnique(args: { where: { id: string } }): Promise<unknown>;
  findFirst(args: { where: { id: string } }): Promise<unknown>;
  count(args: { where: { id: string } }): Promise<number>;
  updateMany(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ count: number }>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  deleteMany(args: { where: { id: string } }): Promise<{ count: number }>;
  delete(args: { where: { id: string } }): Promise<unknown>;
}

export interface TenantTableSpec {
  /** Column that carries the tenant key: `workspace_id`, or `id` for the workspace root itself. */
  tenantKey: 'workspace_id' | 'id';
  /** Only audit_logs: platform events have no workspace (and are invisible to app_user). */
  nullableTenantKey?: true;
  /** Creates the parents a row needs (in ctx.workspaceId). Runs in the caller's transaction. */
  prepare(tx: Tx, ctx: FactoryContext): Promise<Deps>;
  /** Inserts one row and returns its id. */
  insert(tx: Tx, ctx: FactoryContext, deps: Deps): Promise<string>;
  /** A SQL assignment inside app_user's UPDATE column grant, or 'denied' when app_user may not UPDATE. */
  update: string | 'denied';
  /** Whether app_user holds DELETE (soft-deleted and append-only tables do not). */
  delete: 'allowed' | 'denied';
  /** Prisma model and update payload for the IDOR harness. */
  prisma: { model(tx: Tx): IdDelegate; data: Record<string, unknown> };
}

const delegate = (d: unknown) => d as IdDelegate;
const token = () => randomBytes(32).toString('hex');
const project = async (tx: Tx, ctx: FactoryContext) => ({
  projectId: (
    await tx.project.create({
      data: { workspaceId: ctx.workspaceId, name: 'Isolation parent', createdBy: ctx.ownerId },
      select: { id: true },
    })
  ).id,
});
const none = async (): Promise<Deps> => ({});

export const TENANT_TABLES = {
  workspaces: {
    tenantKey: 'id',
    prepare: none,
    insert: async (tx, ctx) =>
      (
        await tx.workspace.create({
          data: { id: ctx.workspaceId, name: 'Isolation', slug: ctx.unique('iso'), createdBy: ctx.ownerId },
          select: { id: true },
        })
      ).id,
    update: `name = 'tampered'`,
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.workspace), data: { name: 'tampered' } },
  },
  memberships: {
    tenantKey: 'workspace_id',
    prepare: async (_tx, ctx) => ({ userId: await ctx.createUser() }),
    insert: async (tx, ctx, deps) =>
      (
        await tx.membership.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: deps.userId!,
            role: 'editor',
            createdBy: ctx.ownerId,
          },
          select: { id: true },
        })
      ).id,
    update: `role = 'viewer'`,
    delete: 'allowed',
    prisma: { model: (tx) => delegate(tx.membership), data: { role: 'viewer' } },
  },
  invitations: {
    tenantKey: 'workspace_id',
    prepare: none,
    insert: async (tx, ctx) =>
      (
        await tx.invitation.create({
          data: {
            workspaceId: ctx.workspaceId,
            email: `${ctx.unique('invitee')}@example.test`,
            role: 'editor',
            tokenHash: token(),
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
            invitedBy: ctx.ownerId,
          },
          select: { id: true },
        })
      ).id,
    update: `revoked_at = now()`,
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.invitation), data: { revokedAt: new Date() } },
  },
  projects: {
    tenantKey: 'workspace_id',
    prepare: none,
    insert: async (tx, ctx) => (await project(tx, ctx)).projectId,
    update: `name = 'tampered'`,
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.project), data: { name: 'tampered' } },
  },
  client_contacts: {
    tenantKey: 'workspace_id',
    prepare: project,
    insert: async (tx, ctx, deps) =>
      (
        await tx.clientContact.create({
          data: {
            workspaceId: ctx.workspaceId,
            projectId: deps.projectId!,
            name: 'Isolation client',
            email: 'client@example.test',
            createdBy: ctx.ownerId,
          },
          select: { id: true },
        })
      ).id,
    update: `name = 'tampered'`,
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.clientContact), data: { name: 'tampered' } },
  },
  domains: {
    tenantKey: 'workspace_id',
    prepare: project,
    // S6: app_user has no INSERT on domains; the allocator is the only path and refuses a project outside the
    // context (42501), which the matrix's cross-tenant and actor-only INSERT checks rely on.
    insert: async (tx, ctx, deps) => {
      const rows = await tx.$queryRaw<Array<{ domain_id: string }>>`
        SELECT domain_id FROM app.allocate_platform_subdomain(${deps.projectId!}::uuid, ${ctx.unique('iso')})`;
      return rows[0]!.domain_id;
    },
    update: `deleted_at = now()`,
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.domain), data: { deletedAt: new Date() } },
  },
  audit_logs: {
    tenantKey: 'workspace_id',
    nullableTenantKey: true,
    prepare: none,
    insert: async (tx, ctx) =>
      (
        await tx.auditLog.create({
          data: {
            workspaceId: ctx.workspaceId,
            actorType: 'user',
            actorId: ctx.ownerId,
            action: 'isolation.seeded',
            result: 'success',
          },
          select: { id: true },
        })
      ).id,
    update: 'denied',
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.auditLog), data: { action: 'isolation.tampered' } },
  },
  notifications: {
    tenantKey: 'workspace_id',
    prepare: none,
    // Addressed to the owner (the acting user), so INSERT ... RETURNING passes the recipient SELECT policy.
    insert: async (tx, ctx) =>
      (
        await tx.notification.create({
          data: { workspaceId: ctx.workspaceId, userId: ctx.ownerId, type: 'isolation.seeded' },
          select: { id: true },
        })
      ).id,
    update: `read_at = now()`,
    delete: 'allowed',
    prisma: { model: (tx) => delegate(tx.notification), data: { readAt: new Date() } },
  },
  notification_preferences: {
    tenantKey: 'workspace_id',
    prepare: none,
    // The member's own choice (self_* policies); ctx.ownerId is the acting user.
    insert: async (tx, ctx) =>
      (
        await tx.notificationPreference.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: ctx.ownerId,
            category: `iso.c${randomBytes(4).toString('hex')}`,
          },
          select: { id: true },
        })
      ).id,
    update: `email = false`,
    delete: 'allowed',
    prisma: { model: (tx) => delegate(tx.notificationPreference), data: { email: false } },
  },
  outbox_events: {
    tenantKey: 'workspace_id',
    prepare: none,
    insert: async (tx, ctx) =>
      (
        await tx.outboxEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            event: 'isolation.seeded.v1',
            payload: { workspaceId: ctx.workspaceId },
          },
          select: { id: true },
        })
      ).id,
    update: `last_error = 'tampered'`,
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.outboxEvent), data: { lastError: 'tampered' } },
  },
  job_dead_letters: {
    tenantKey: 'workspace_id',
    prepare: none,
    insert: async (tx, ctx) =>
      (
        await tx.jobDeadLetter.create({
          data: { workspaceId: ctx.workspaceId, functionId: 'isolation-v1', runId: 'iso', error: 'seeded' },
          select: { id: true },
        })
      ).id,
    update: 'denied',
    delete: 'denied',
    prisma: { model: (tx) => delegate(tx.jobDeadLetter), data: { error: 'tampered' } },
  },
} satisfies Record<string, TenantTableSpec>;

export type TableName = keyof typeof TENANT_TABLES;
export const TABLE_NAMES = Object.keys(TENANT_TABLES) as TableName[];
export const spec = (table: TableName): TenantTableSpec => TENANT_TABLES[table];

/**
 * Relations in product schemas that hold no tenant rows, each with the reason. `registry.test.ts` also proves
 * that app_user can read none of them.
 */
export const NON_TENANT_RELATIONS: Record<string, string> = {
  'app._prisma_migrations': 'Prisma migration ledger, private to migrator',
  'app.platform_settings':
    'per-environment platform settings (sites_domain); no app_user grant or policy; operator function only',
  'app.platform_admins':
    'platform role grants; no app_user grant or policy; written by operator definer functions',
  'app.admin_step_ups':
    'admin console step-ups (P1 S8), bound to a platform admin and a session; no application role has a grant or policy; written and read only by the app_admin definer functions',
  'identity.users': 'Better Auth (app_auth only); a user spans workspaces through memberships',
  'identity.sessions': 'Better Auth (app_auth only)',
  'identity.accounts': 'Better Auth (app_auth only)',
  'identity.verifications': 'Better Auth (app_auth only)',
  'identity.two_factors': 'Better Auth (app_auth only)',
  'identity.rate_limits': 'Better Auth (app_auth only)',
};
