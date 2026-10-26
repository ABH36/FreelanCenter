/**
 * Projects (module 02; FR-PRJ-01 P1 part, FR-PRJ-02..05, FR-DOM-01, Q9). One project is one client's site inside a
 * workspace, with its own contact, platform subdomain and lifecycle. Every command follows the scoped pattern
 * (`scoped.ts`): membership -> capability -> lookup -> mutation + audit in one RLS transaction, and the database
 * repeats the rules (transition table and role checks in `projects_guard`, subdomains only through
 * `app.allocate_platform_subdomain`).
 *
 * Idempotency (cross-module contracts): create and duplicate carry a request key from the form; the same key
 * returns the project it made, a different payload under that key is refused. Transitions carry the status the
 * user saw (`from`): repeating a transition that already happened is a no-op, a transition from a status that
 * changed meanwhile is STALE; a compare-and-set UPDATE makes concurrent transitions race-safe.
 *
 * Host routing (S7, FR-DOM-07): every command that changes what a project's hosts may show (create, duplicate,
 * status change) writes a `sites.hosts.changed.v1` outbox row in its transaction; after commit the outbox emits
 * it and the invalidation job drops the cached host resolutions in apps/sites.
 */
import { type Capability, can } from '@platform/auth/rbac';
import { type Prisma, type TenantDatabase, type TenantScope, type Tx, isUuid, uuidv7 } from '@platform/db';
import type { Logger } from '@platform/logger';
import { z } from 'zod';
import { WorkspaceError, errorCodes } from './errors';
import {
  PROJECT_STATUSES,
  type ProjectStatus,
  type Transition,
  findTransition,
  isProjectStatus,
  transitionsFrom,
} from './lifecycle';
import { notify } from './notifications';
import { OUTBOX_EVENTS, type Outbox } from './outbox';
import { createScopedRunner, memberActor, parse, requireId } from './scoped';
import { subdomainLabel } from './slug';

/** FR-TPL-08 taxonomy; templates arrive in P2, the category is already filterable. */
export const PROJECT_CATEGORIES = {
  gym: 'Gym',
  taxi: 'Taxi',
  wedding_event: 'Wedding / event',
  distributor: 'Distributor',
  salon: 'Salon',
  clinic: 'Clinic',
  restaurant: 'Restaurant',
  coaching: 'Coaching',
  real_estate: 'Real estate',
  generic: 'Other',
} as const;
export type ProjectCategory = keyof typeof PROJECT_CATEGORIES;
const CATEGORY_KEYS = Object.keys(PROJECT_CATEGORIES) as [ProjectCategory, ...ProjectCategory[]];

/** SEC-09-style abuse limit (placeholder until plans, P6) and list page size. */
export const PROJECT_LIMITS = { createsPerDay: 100, pageSize: 20 } as const;

export type ProjectAuditAction =
  | 'project.created'
  | 'project.duplicated'
  | 'project.updated'
  | 'project.status_changed'
  | 'project.client_contact.saved'
  | 'project.client_contact.removed';

export type StatusFilter = ProjectStatus | 'active' | 'all';

export interface ProjectFilters {
  q?: unknown;
  status?: unknown;
  category?: unknown;
  client?: unknown;
  cursor?: unknown;
}

export interface ProjectListItem {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  status: ProjectStatus;
  statusChangedAt: Date;
  createdAt: Date;
  clientName: string | null;
  /** Health indicators (FR-PRJ-04). Unread leads arrive with leads in P5. */
  health: { subdomain: { hostname: string; status: string } | null; pendingReview: boolean };
}

export interface ProjectDetail extends Omit<ProjectListItem, 'clientName'> {
  contact: { name: string; phone: string | null; email: string | null; whatsapp: string | null } | null;
  duplicatedFrom: { id: string; name: string } | null;
  /** What this actor may do now; the commands re-check on the server. */
  transitions: Array<Pick<Transition, 'from' | 'to' | 'label'>>;
  canEdit: boolean;
  canDuplicate: boolean;
}

const nameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.'));
const optionalText = (max: number) =>
  z
    .string()
    .optional()
    .transform((s) => s?.replace(/\s+/g, ' ').trim() || null)
    .pipe(z.string().max(max, `Use at most ${max} characters.`).nullable());
const categorySchema = z
  .string()
  .optional()
  .transform((s) => s || null)
  .pipe(z.enum(CATEGORY_KEYS, 'Choose a category from the list.').nullable());
const requestKeySchema = z.uuid('Reload the page and try again.');
const phoneSchema = z
  .string()
  .optional()
  .transform((s) => s?.trim() || null)
  .pipe(
    z
      .string()
      .regex(/^\+?[0-9][0-9 ()-]{5,22}$/, 'Enter a phone number with digits, spaces, "-" or "+".')
      .nullable(),
  );
const contactSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
  whatsapp: phoneSchema,
  email: z
    .string()
    .optional()
    .transform((s) => s?.trim().toLowerCase() || null)
    .pipe(z.email('Enter a valid e-mail address.').max(320).nullable()),
});
type ContactInput = z.output<typeof contactSchema>;

/** LIKE pattern for a user's search text: their `%`, `_` and `\` match literally. */
export function likePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function textFilter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, 100);
  return text || null;
}

export function parseStatusFilter(value: unknown): StatusFilter {
  if (value === 'all' || isProjectStatus(value)) return value;
  return 'active';
}

const SELECT_LIST = {
  id: true,
  name: true,
  category: true,
  city: true,
  status: true,
  statusChangedAt: true,
  createdAt: true,
  domains: {
    where: { type: 'subdomain', deletedAt: null },
    select: { hostname: true, status: true },
    take: 1,
  },
} as const satisfies Prisma.ProjectSelect;

function health(row: { status: ProjectStatus; domains: Array<{ hostname: string; status: string }> }) {
  return { subdomain: row.domains[0] ?? null, pendingReview: row.status === 'in_review' };
}

export interface ProjectServiceDeps {
  db: TenantDatabase;
  outbox: Outbox;
  logger?: Logger;
  /** Default PROJECT_LIMITS.createsPerDay; the load test raises it to seed a large workspace. */
  createsPerDay?: number;
}

export function createProjectService(deps: ProjectServiceDeps) {
  const { db, outbox, logger } = deps;
  const createsPerDay = deps.createsPerDay ?? PROJECT_LIMITS.createsPerDay;
  const runner = createScopedRunner(db, logger);
  const command = <T>(
    actorUserId: string,
    workspaceId: unknown,
    spec: { action: ProjectAuditAction; capability: Capability },
    fn: Parameters<typeof runner.command<T>>[3],
  ) => runner.command(actorUserId, workspaceId, spec, fn);

  async function findProject(tx: Tx, projectId: unknown) {
    const id = requireId(projectId);
    const project = await tx.project.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        category: true,
        city: true,
        status: true,
        createdBy: true,
        clientContactId: true,
        duplicatedFromId: true,
      },
    });
    if (!project) throw new WorkspaceError('NOT_FOUND');
    return project;
  }

  async function allocateSubdomain(tx: Tx, projectId: string, name: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ hostname: string }>>`
      SELECT hostname FROM app.allocate_platform_subdomain(${projectId}::uuid, ${subdomainLabel(name)})`;
    const hostname = rows[0]?.hostname;
    if (!hostname) throw new Error('subdomain allocation returned nothing');
    return hostname;
  }

  /** The outbox row that makes apps/sites forget the project's cached host resolutions after commit. */
  async function hostsChanged(tx: Tx, scope: TenantScope, projectId: string): Promise<string> {
    const id = uuidv7();
    await tx.outboxEvent.createMany({
      data: [
        {
          id,
          workspaceId: scope.workspaceId,
          event: OUTBOX_EVENTS.siteHostsChanged,
          payload: { workspaceId: scope.workspaceId, projectId },
        },
      ],
    });
    return id;
  }

  async function dispatchAfterCommit(workspaceId: unknown, ids: readonly string[]): Promise<void> {
    if (ids.length) await outbox.dispatch(requireId(workspaceId), ids);
  }

  async function enforceCreateLimit(tx: Tx) {
    const since = new Date(Date.now() - 86_400_000);
    if ((await tx.project.count({ where: { createdAt: { gt: since } } })) >= createsPerDay) {
      throw new WorkspaceError('RATE_LIMITED');
    }
  }

  async function insertContact(tx: Tx, scope: TenantScope, projectId: string, contact: ContactInput) {
    const id = uuidv7();
    await tx.clientContact.create({
      data: { id, workspaceId: scope.workspaceId, projectId, createdBy: scope.actorUserId, ...contact },
      select: { id: true },
    });
    await tx.project.update({
      where: { id: projectId },
      data: { clientContactId: id },
      select: { id: true },
    });
  }

  /**
   * A create/duplicate under a request key that was already used. Same payload: the original project, no new
   * audit row. Different payload: refused.
   */
  async function replay(
    tx: Tx,
    requestKey: string,
    matches: (p: { name: string; duplicatedFromId: string | null }) => boolean,
  ) {
    const existing = await tx.project.findFirst({
      where: { creationKey: requestKey },
      select: { id: true, name: true, duplicatedFromId: true },
    });
    if (!existing) return null;
    if (!matches(existing)) throw new WorkspaceError('IDEMPOTENCY_MISMATCH');
    return existing.id;
  }

  /** Two submissions of the same form racing: the loser hits the unique request key and returns the winner. */
  async function onKeyConflict<T>(run: () => Promise<T>, recover: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const codes = errorCodes(error);
      if (codes.includes('23505') || codes.includes('P2002')) return recover();
      throw error;
    }
  }

  async function recipientsFor(tx: Tx, scope: TenantScope, to: ProjectStatus, createdBy: string | null) {
    if (to === 'in_review') {
      const approvers = await tx.membership.findMany({
        where: { workspaceId: scope.workspaceId, role: { in: ['owner', 'admin'] } },
        select: { userId: true },
      });
      return {
        category: 'project.review' as const,
        type: 'project.review_requested',
        ids: approvers.map((m) => m.userId),
      };
    }
    const creator = createdBy
      ? await tx.membership.findFirst({
          where: { workspaceId: scope.workspaceId, userId: createdBy },
          select: { userId: true },
        })
      : null;
    return {
      category: 'project.status' as const,
      type: 'project.status_changed',
      ids: creator ? [creator.userId] : [],
    };
  }

  return {
    /** FR-PRJ-04: search (name, city), filter (status, category, client), keyset pagination, health. */
    async listProjects(
      actorUserId: string,
      workspaceId: unknown,
      filters: ProjectFilters = {},
    ): Promise<{ items: ProjectListItem[]; nextCursor: string | null }> {
      return runner.query(actorUserId, workspaceId, 'projects.view', async (tx) => {
        const status = parseStatusFilter(filters.status);
        const q = textFilter(filters.q);
        const client = textFilter(filters.client);
        const category =
          typeof filters.category === 'string' && filters.category in PROJECT_CATEGORIES
            ? filters.category
            : null;
        const cursor =
          typeof filters.cursor === 'string' && filters.cursor ? requireId(filters.cursor) : null;
        const contains = (text: string) => ({ contains: likePattern(text), mode: 'insensitive' as const });
        const where: Prisma.ProjectWhereInput = {
          deletedAt: null,
          ...(status === 'active' ? { status: { not: 'archived' } } : status === 'all' ? {} : { status }),
          ...(category ? { category } : {}),
          ...(q ? { OR: [{ name: contains(q) }, { city: contains(q) }] } : {}),
          ...(client
            ? {
                primaryContact: {
                  is: {
                    deletedAt: null,
                    OR: [
                      { name: contains(client) },
                      { email: contains(client) },
                      { phone: contains(client) },
                    ],
                  },
                },
              }
            : {}),
          ...(cursor ? { id: { lt: cursor } } : {}),
        };
        const rows = await tx.project.findMany({
          where,
          orderBy: { id: 'desc' },
          take: PROJECT_LIMITS.pageSize + 1,
          select: { ...SELECT_LIST, primaryContact: { select: { name: true, deletedAt: true } } },
        });
        const items = rows.slice(0, PROJECT_LIMITS.pageSize).map((r) => ({
          id: r.id,
          name: r.name,
          category: r.category,
          city: r.city,
          status: r.status,
          statusChangedAt: r.statusChangedAt,
          createdAt: r.createdAt,
          clientName: r.primaryContact && !r.primaryContact.deletedAt ? r.primaryContact.name : null,
          health: health(r),
        }));
        return {
          items,
          nextCursor: rows.length > PROJECT_LIMITS.pageSize ? (items.at(-1)?.id ?? null) : null,
        };
      });
    },

    /** Names for display (notifications); ids of other workspaces or unknown ids are simply absent. */
    async projectNames(actorUserId: string, workspaceId: unknown, ids: readonly unknown[]) {
      const valid = [...new Set(ids)]
        .filter((id): id is string => typeof id === 'string' && isUuid(id))
        .slice(0, 100);
      return runner.query(actorUserId, workspaceId, 'projects.view', async (tx) => {
        const rows = valid.length
          ? await tx.project.findMany({ where: { id: { in: valid } }, select: { id: true, name: true } })
          : [];
        return new Map(rows.map((r) => [r.id, r.name]));
      });
    },

    /** The project page `/w/<slug>/projects/<id>`; NOT_FOUND for another workspace's id and an unknown one alike. */
    async getProject(actorUserId: string, workspaceId: unknown, projectId: unknown): Promise<ProjectDetail> {
      return runner.query(actorUserId, workspaceId, 'projects.view', async (tx, scope) => {
        const id = requireId(projectId);
        const row = await tx.project.findFirst({
          where: { id, deletedAt: null },
          select: {
            ...SELECT_LIST,
            primaryContact: {
              select: { name: true, phone: true, email: true, whatsapp: true, deletedAt: true },
            },
            duplicatedFrom: { select: { id: true, name: true } },
          },
        });
        if (!row) throw new WorkspaceError('NOT_FOUND');
        const actor = memberActor(scope);
        const hasSubdomain = row.domains[0]?.status === 'active';
        const contact =
          row.primaryContact && !row.primaryContact.deletedAt
            ? {
                name: row.primaryContact.name,
                phone: row.primaryContact.phone,
                email: row.primaryContact.email,
                whatsapp: row.primaryContact.whatsapp,
              }
            : null;
        return {
          id: row.id,
          name: row.name,
          category: row.category,
          city: row.city,
          status: row.status,
          statusChangedAt: row.statusChangedAt,
          createdAt: row.createdAt,
          health: health(row),
          contact,
          duplicatedFrom: row.duplicatedFrom,
          transitions: scope.writable
            ? transitionsFrom(row.status)
                .filter((t) => can(actor, t.capability) && (t.to !== 'live' || hasSubdomain))
                .map(({ from, to, label }) => ({ from, to, label }))
            : [],
          canEdit: scope.writable && row.status !== 'archived' && can(actor, 'draft.edit'),
          canDuplicate: scope.writable && can(actor, 'projects.create'),
        };
      });
    },

    /** FR-PRJ-01 (P1 part: no template yet) + FR-DOM-01: a Draft project with its platform subdomain. */
    async createProject(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        requestKey: unknown;
        name: unknown;
        category?: unknown;
        city?: unknown;
        contact?: { name?: unknown; phone?: unknown; email?: unknown; whatsapp?: unknown } | null;
      },
    ): Promise<{ id: string }> {
      const requestKey = parse(requestKeySchema, input.requestKey, 'requestKey');
      const name = parse(nameSchema, input.name, 'name');
      const category = parse(categorySchema, input.category ?? undefined, 'category');
      const city = parse(optionalText(80), input.city ?? undefined, 'city');
      const hasContact = Object.values(input.contact ?? {}).some((v) => typeof v === 'string' && v.trim());
      const contact = hasContact ? parse(contactSchema, input.contact, 'contact') : null;
      const sameRequest = (p: { name: string; duplicatedFromId: string | null }) =>
        p.name === name && p.duplicatedFromId === null;
      const run = () =>
        command(
          actorUserId,
          input.workspaceId,
          { action: 'project.created', capability: 'projects.create' },
          async (tx, scope) => {
            const replayed = await replay(tx, requestKey, sameRequest);
            if (replayed) return { result: { id: replayed, outboxIds: [] as string[] }, audit: null };
            await enforceCreateLimit(tx);
            const id = uuidv7();
            await tx.project.create({
              data: { id, workspaceId: scope.workspaceId, name, category, city, creationKey: requestKey },
              select: { id: true },
            });
            if (contact) await insertContact(tx, scope, id, contact);
            const hostname = await allocateSubdomain(tx, id, name);
            // A visitor may have hit this host name before it existed (negative cache entry).
            const outboxIds = [await hostsChanged(tx, scope, id)];
            return {
              result: { id, outboxIds },
              audit: {
                targetType: 'project',
                targetId: id,
                projectId: id,
                metadata: { hostname, category, has_client_contact: contact !== null },
              },
            };
          },
        );
      const created = await onKeyConflict(run, run);
      await dispatchAfterCommit(input.workspaceId, created.outboxIds);
      return { id: created.id };
    },

    /** FR-PRJ-05: a new Draft with the same details and its own subdomain; the client contact is not copied. */
    async duplicateProject(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; requestKey: unknown },
    ): Promise<{ id: string }> {
      const requestKey = parse(requestKeySchema, input.requestKey, 'requestKey');
      const run = () =>
        command(
          actorUserId,
          input.workspaceId,
          { action: 'project.duplicated', capability: 'projects.create' },
          async (tx, scope) => {
            const source = await findProject(tx, input.projectId);
            const replayed = await replay(tx, requestKey, (p) => p.duplicatedFromId === source.id);
            if (replayed) return { result: { id: replayed, outboxIds: [] as string[] }, audit: null };
            await enforceCreateLimit(tx);
            const id = uuidv7();
            await tx.project.create({
              data: {
                id,
                workspaceId: scope.workspaceId,
                name: `Copy of ${source.name}`.slice(0, 120).trim(),
                category: source.category,
                city: source.city,
                creationKey: requestKey,
                duplicatedFromId: source.id,
              },
              select: { id: true },
            });
            const hostname = await allocateSubdomain(tx, id, source.name);
            const outboxIds = [await hostsChanged(tx, scope, id)];
            return {
              result: { id, outboxIds },
              audit: {
                targetType: 'project',
                targetId: id,
                projectId: id,
                metadata: { source_project_id: source.id, hostname },
              },
            };
          },
        );
      const created = await onKeyConflict(run, run);
      await dispatchAfterCommit(input.workspaceId, created.outboxIds);
      return { id: created.id };
    },

    /** Name, category, city. The subdomain does not follow a rename (addresses stay stable). */
    async updateProject(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; name: unknown; category?: unknown; city?: unknown },
    ) {
      const name = parse(nameSchema, input.name, 'name');
      const category = parse(categorySchema, input.category ?? undefined, 'category');
      const city = parse(optionalText(80), input.city ?? undefined, 'city');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'project.updated', capability: 'draft.edit' },
        async (tx) => {
          const project = await findProject(tx, input.projectId);
          if (project.status === 'archived') throw new WorkspaceError('ARCHIVED');
          const changed = (['name', 'category', 'city'] as const).filter(
            (f) => project[f] !== { name, category, city }[f],
          );
          if (changed.length === 0) return { result: undefined, audit: null };
          await tx.project.update({
            where: { id: project.id },
            data: { name, category, city },
            select: { id: true },
          });
          return {
            result: undefined,
            audit: {
              targetType: 'project',
              targetId: project.id,
              projectId: project.id,
              metadata: { fields: changed.join(',') },
            },
          };
        },
      );
    },

    /** FR-PRJ-03: the project's primary client contact (Confidential PII: never in audit metadata or logs). */
    async saveClientContact(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        projectId: unknown;
        name: unknown;
        phone?: unknown;
        email?: unknown;
        whatsapp?: unknown;
      },
    ) {
      const contact = parse(contactSchema, input, 'contact');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'project.client_contact.saved', capability: 'draft.edit' },
        async (tx, scope) => {
          const project = await findProject(tx, input.projectId);
          if (project.status === 'archived') throw new WorkspaceError('ARCHIVED');
          const current = project.clientContactId
            ? await tx.clientContact.findFirst({
                where: { id: project.clientContactId, deletedAt: null },
                select: { id: true, name: true, phone: true, email: true, whatsapp: true },
              })
            : null;
          if (current) {
            const same = (['name', 'phone', 'email', 'whatsapp'] as const).every(
              (f) => current[f] === contact[f],
            );
            if (same) return { result: undefined, audit: null };
            await tx.clientContact.update({ where: { id: current.id }, data: contact, select: { id: true } });
          } else {
            await insertContact(tx, scope, project.id, contact);
          }
          return {
            result: undefined,
            audit: {
              targetType: 'project',
              targetId: project.id,
              projectId: project.id,
              metadata: {
                created: current === null,
                has_phone: contact.phone !== null,
                has_email: contact.email !== null,
                has_whatsapp: contact.whatsapp !== null,
              },
            },
          };
        },
      );
    },

    /** Unlinks and soft-deletes the contact; the row itself is purged by the retention job (SEC-20, P8). */
    async removeClientContact(actorUserId: string, input: { workspaceId: unknown; projectId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'project.client_contact.removed', capability: 'draft.edit' },
        async (tx) => {
          const project = await findProject(tx, input.projectId);
          if (project.status === 'archived') throw new WorkspaceError('ARCHIVED');
          if (!project.clientContactId) return { result: undefined, audit: null };
          await tx.project.update({
            where: { id: project.id },
            data: { clientContactId: null },
            select: { id: true },
          });
          await tx.clientContact.updateMany({
            where: { id: project.clientContactId, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          return {
            result: undefined,
            audit: { targetType: 'project', targetId: project.id, projectId: project.id },
          };
        },
      );
    },

    /**
     * FR-PRJ-02: one transition of the table, validated, authorized by its capability before any lookup, applied
     * with compare-and-set, audited, and notified (in-app + e-mail through the outbox).
     */
    async transitionProject(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; from: unknown; to: unknown },
    ): Promise<{ status: ProjectStatus; changed: boolean }> {
      if (!isProjectStatus(input.from) || !isProjectStatus(input.to)) {
        throw new WorkspaceError('INVALID_INPUT', { to: `Choose one of ${PROJECT_STATUSES.join(', ')}.` });
      }
      const { from, to } = input;
      // Pure input validation: the same answer for every workspace id, so it reveals nothing (IDOR).
      const transition = findTransition(from, to);
      if (!transition) throw new WorkspaceError('INVALID_TRANSITION');
      const outcome = await command(
        actorUserId,
        input.workspaceId,
        { action: 'project.status_changed', capability: transition.capability },
        async (tx, scope) => {
          const project = await findProject(tx, input.projectId);
          const unchanged = {
            result: { status: to, changed: false, outboxIds: [] as string[] },
            audit: null,
          };
          if (project.status === to) return unchanged;
          if (project.status !== from) throw new WorkspaceError('STALE');
          const { count } = await tx.project.updateMany({
            where: { id: project.id, status: from },
            data: { status: to },
          });
          if (count === 0) {
            // A concurrent transition won between our read and the UPDATE (row lock + re-check).
            const now = await tx.project.findFirst({ where: { id: project.id }, select: { status: true } });
            if (now?.status === to) return unchanged;
            throw new WorkspaceError('STALE');
          }
          const recipients = await recipientsFor(tx, scope, to, project.createdBy);
          const outboxIds = await notify(tx, scope, {
            category: recipients.category,
            type: recipients.type,
            recipients: recipients.ids,
            payload: { projectId: project.id, from, to },
          });
          outboxIds.push(await hostsChanged(tx, scope, project.id));
          return {
            result: { status: to, changed: true, outboxIds },
            audit: {
              targetType: 'project',
              targetId: project.id,
              projectId: project.id,
              metadata: { from, to },
            },
          };
        },
      );
      await dispatchAfterCommit(input.workspaceId, outcome.outboxIds);
      return { status: outcome.status, changed: outcome.changed };
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
