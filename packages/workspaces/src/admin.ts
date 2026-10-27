/**
 * Admin console v0 (P1 S8; FR-ADM-01 basic, FR-ADM-02 workspace, SEC-17). Platform staff list and search
 * workspaces and users, read the platform audit trail, and suspend or unsuspend a workspace with a reason.
 *
 * Authorization lives in the database: every call goes through an app_admin definer function that re-checks the
 * platform-admin grant, TOTP enrolment, the live session and a fresh TOTP step-up (`@platform/db/admin`). This
 * service validates input, turns database refusals into typed errors and dispatches the suspension's host-cache
 * invalidations after commit. The principal (user id + session id) always comes from the server-side session.
 */
import { type AdminDatabase, type AdminPrincipal, type AdminWorkspaceStatus } from '@platform/db/admin';
import { isUuid } from '@platform/db';
import { type Logger, getLogContext } from '@platform/logger';
import { WorkspaceError, errorCodes } from './errors';
import type { Outbox } from './outbox';

export type { AdminPrincipal } from '@platform/db/admin';

export const ADMIN_PAGE_SIZE = 50;
export const ADMIN_REASON = { min: 3, max: 500 } as const;
const TOTP_CODE = /^\d{6}$/;
const ACTION_FILTER = /^[a-z][a-z0-9_.]{0,99}$/;

/** Checks a TOTP code for the signed-in admin (the dashboard passes Better Auth's verifier). */
export type TotpVerifier = (code: string) => Promise<boolean>;

export interface AdminServiceDeps {
  db: AdminDatabase;
  /** The dashboard's outbox: dispatches the suspension's `sites.hosts.changed.v1` rows after commit. */
  outbox: Outbox;
  logger?: Logger;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const correlationId = () => getLogContext()?.correlationId ?? null;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const cursorOf = (value: unknown) => (typeof value === 'string' && isUuid(value) ? value : null);

/** Database refusals of the admin functions as typed errors; anything else is rethrown. */
function translate(error: unknown): never {
  if (error instanceof WorkspaceError) throw error;
  const codes = errorCodes(error);
  if (codes.includes('42501')) throw new WorkspaceError('FORBIDDEN');
  if (codes.includes('22023')) throw new WorkspaceError('INVALID_INPUT');
  if (codes.includes('P0002')) throw new WorkspaceError('NOT_FOUND');
  throw error;
}

async function page<T extends { id: string }>(
  limit: number,
  load: (limit: number) => Promise<T[]>,
): Promise<Page<T>> {
  const rows = await load(limit + 1).catch(translate);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export function createAdminService(deps: AdminServiceDeps) {
  const { db, outbox, logger } = deps;

  return {
    /** The console guard: whether this session may use the console, its step-up and any lockout. */
    state(p: AdminPrincipal) {
      return db.consoleState(p);
    },

    /**
     * The console's TOTP step-up (SEC-17). The attempt is recorded before the code is checked, so a request that
     * dies half-way still counts towards the lockout (5 per 15 minutes). A malformed code starts no attempt.
     */
    async stepUp(p: AdminPrincipal, code: unknown, verify: TotpVerifier): Promise<{ until: Date }> {
      const value = text(code).replace(/\s+/g, '');
      if (!TOTP_CODE.test(value)) {
        throw new WorkspaceError('INVALID_INPUT', { code: 'Enter the 6-digit code from your app.' });
      }
      const attemptId = await db.beginStepUp(p, correlationId()).catch(translate);
      if (!attemptId) {
        logger?.warn('admin.step_up.locked', { userId: p.userId });
        throw new WorkspaceError('MFA_LOCKED');
      }
      // A verifier error leaves the attempt pending: it counts as a failure and the error propagates.
      const verified = await verify(value);
      const until = await db.finishStepUp(p, attemptId, verified, correlationId()).catch(translate);
      logger?.info('admin.step_up', { userId: p.userId, verified });
      if (!verified || !until) throw new WorkspaceError('MFA_CODE_INVALID');
      return { until };
    },

    /** Query: empty, a workspace id, or text (slug prefix / name substring). Searches are audited. */
    async listWorkspaces(
      p: AdminPrincipal,
      filters: { query?: unknown; status?: unknown; cursor?: unknown } = {},
    ) {
      const query = text(filters.query);
      if (query.length > 100) throw new WorkspaceError('INVALID_INPUT', { query: 'At most 100 characters.' });
      const status: AdminWorkspaceStatus | null =
        filters.status === 'active' || filters.status === 'suspended' ? filters.status : null;
      return page(ADMIN_PAGE_SIZE, (limit) =>
        db.listWorkspaces(
          p,
          { query: query || null, status, before: cursorOf(filters.cursor), limit },
          correlationId(),
        ),
      );
    },

    /** One workspace (audited as a view); null for a malformed or unknown id. */
    async getWorkspace(p: AdminPrincipal, workspaceId: unknown) {
      if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) return null;
      return db.getWorkspace(p, workspaceId, correlationId()).catch(translate);
    },

    /** Query: empty, a user id, or one exact e-mail address; never a fragment (data minimisation). */
    async listUsers(p: AdminPrincipal, filters: { query?: unknown; cursor?: unknown } = {}) {
      const query = text(filters.query).toLowerCase();
      const byId: boolean = isUuid(query);
      if (query && !byId && !query.includes('@')) {
        throw new WorkspaceError('INVALID_INPUT', {
          query: 'Search by user id or the exact e-mail address.',
        });
      }
      if (query.length > 254) throw new WorkspaceError('INVALID_INPUT', { query: 'Too long.' });
      return page(ADMIN_PAGE_SIZE, (limit) =>
        db.listUsers(p, { query: query || null, before: cursorOf(filters.cursor), limit }, correlationId()),
      );
    },

    /** Platform audit rows and every admin-written row; malformed filters are dropped. */
    async listAudit(
      p: AdminPrincipal,
      filters: { action?: unknown; actorId?: unknown; cursor?: unknown } = {},
    ) {
      const action = text(filters.action);
      const actorId = text(filters.actorId);
      return page(ADMIN_PAGE_SIZE, (limit) =>
        db.listAudit(p, {
          action: ACTION_FILTER.test(action) ? action : null,
          actorId: isUuid(actorId) ? actorId : null,
          before: cursorOf(filters.cursor),
          limit,
        }),
      );
    },

    /**
     * FR-ADM-02 / FR-WS-04: suspend or unsuspend with a reason. The definer function changes the status, writes
     * the audit row and one `sites.hosts.changed.v1` outbox row per project in one transaction (S7 D12); the rows
     * are dispatched here after commit, and the outbox sweep re-emits any that are lost.
     */
    async setWorkspaceStatus(
      p: AdminPrincipal,
      input: { workspaceId: unknown; status: unknown; reason: unknown },
    ): Promise<{ changed: boolean }> {
      const reason = text(input.reason);
      const fieldErrors: Record<string, string> = {};
      if (reason.length < ADMIN_REASON.min || reason.length > ADMIN_REASON.max) {
        fieldErrors.reason = `Give a reason of ${ADMIN_REASON.min} to ${ADMIN_REASON.max} characters.`;
      }
      if (input.status !== 'active' && input.status !== 'suspended') fieldErrors.status = 'Choose a status.';
      if (Object.keys(fieldErrors).length) throw new WorkspaceError('INVALID_INPUT', fieldErrors);
      if (typeof input.workspaceId !== 'string' || !isUuid(input.workspaceId))
        throw new WorkspaceError('NOT_FOUND');
      const workspaceId = input.workspaceId;
      const status = input.status as AdminWorkspaceStatus;

      const { changed, outboxIds } = await db
        .setWorkspaceStatus(p, { workspaceId, status, reason }, correlationId())
        .catch(translate);
      logger?.info('admin.workspace.status_set', {
        userId: p.userId,
        workspaceId,
        status,
        changed,
        invalidations: outboxIds.length,
      });
      await outbox.dispatch(workspaceId, outboxIds);
      return { changed };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
