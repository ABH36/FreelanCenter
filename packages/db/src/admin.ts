/**
 * The `app_admin` client for the admin console (P1 S8; FR-ADM-01, FR-ADM-02, SEC-17). Exported as
 * `@platform/db/admin`. app_admin holds no table privilege: every method calls one SECURITY DEFINER function of
 * migration p1_s8_admin_console, and each of those re-checks in the database that the principal is an active
 * platform admin with TOTP enrolled, on a live session, stepped up within the last 15 minutes (except
 * `consoleState` and the two step-up calls, which check everything but the step-up).
 *
 * The principal is always the server-resolved session (user id + Better Auth session id), never browser input.
 * No tenant context is set on this pool.
 */
import pg from 'pg';
import { connectionConfig } from './connection';
import { assertUrlRole } from './env';
import { UnsafeRoleError } from './errors';

export interface AdminPrincipal {
  userId: string;
  sessionId: string;
}

export interface AdminConsoleState {
  isAdmin: boolean;
  stepUpUntil: Date | null;
  lockedUntil: Date | null;
}

export type AdminWorkspaceStatus = 'active' | 'suspended';

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  status: AdminWorkspaceStatus;
  suspendedAt: Date | null;
  deletionScheduled: boolean;
  createdAt: Date;
  memberCount: number;
  projectCount: number;
}

export interface AdminWorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  status: AdminWorkspaceStatus;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  deletionScheduledAt: Date | null;
  createdAt: Date;
  memberCount: number;
  /** Owners as id + masked address (`a***@example.com`). */
  owners: Array<{ userId: string; email: string }>;
  /** At most 200, newest first: status and public host names only. */
  projects: Array<{ id: string; status: string; hosts: string[] }>;
}

export interface AdminUserRow {
  id: string;
  emailMasked: string;
  status: 'active' | 'suspended' | 'deactivated';
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
  workspaceCount: number;
  platformAdmin: boolean;
}

export interface AdminAuditRow {
  id: string;
  createdAt: Date;
  workspaceId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: 'success' | 'failure' | 'denied';
  correlationId: string | null;
  metadata: Record<string, unknown>;
}

export interface AdminDatabaseOptions {
  connectionString: string;
  /** Client-side pool size (Spike B B-3: explicit). Default 3: the console has few concurrent users. */
  poolMax?: number;
  /** Per-query timeout in ms. Default 5 s. */
  queryTimeoutMs?: number;
  /** Opening a pooled connection (S7-10: a cold live connection can take over 3 s). Default 10 s. */
  connectTimeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface AdminDatabase {
  consoleState(p: AdminPrincipal): Promise<AdminConsoleState>;
  /** null while the step-up is locked (the refusal is audited). */
  beginStepUp(p: AdminPrincipal, correlationId: string | null): Promise<string | null>;
  /** The end of the step-up, or null for a wrong code. */
  finishStepUp(
    p: AdminPrincipal,
    attemptId: string,
    verified: boolean,
    correlationId: string | null,
  ): Promise<Date | null>;
  listWorkspaces(
    p: AdminPrincipal,
    filters: {
      query: string | null;
      status: AdminWorkspaceStatus | null;
      before: string | null;
      limit: number;
    },
    correlationId: string | null,
  ): Promise<AdminWorkspaceRow[]>;
  getWorkspace(
    p: AdminPrincipal,
    workspaceId: string,
    correlationId: string | null,
  ): Promise<AdminWorkspaceDetail | null>;
  listUsers(
    p: AdminPrincipal,
    filters: { query: string | null; before: string | null; limit: number },
    correlationId: string | null,
  ): Promise<AdminUserRow[]>;
  listAudit(
    p: AdminPrincipal,
    filters: { action: string | null; actorId: string | null; before: string | null; limit: number },
  ): Promise<AdminAuditRow[]>;
  /** The outbox ids are dispatched by the caller after this returns (the transaction has committed). */
  setWorkspaceStatus(
    p: AdminPrincipal,
    input: { workspaceId: string; status: AdminWorkspaceStatus; reason: string },
    correlationId: string | null,
  ): Promise<{ changed: boolean; outboxIds: string[] }>;
  /** Fails unless the connection role is app_admin without SUPERUSER or BYPASSRLS. */
  verifyRole(): Promise<void>;
  close(): Promise<void>;
}

export function createAdminDatabase(options: AdminDatabaseOptions): AdminDatabase {
  assertUrlRole('admin', options.connectionString);
  const pool = new pg.Pool({
    ...connectionConfig(options.connectionString, options.env),
    max: options.poolMax ?? 3,
    query_timeout: options.queryTimeoutMs ?? 5_000,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
  });
  // An idle client that loses its connection must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);

  const query = async <R extends pg.QueryResultRow>(sql: string, values: unknown[]) =>
    (await pool.query<R>(sql, values)).rows;

  return {
    async consoleState(p) {
      const [row] = await query<{ is_admin: boolean; step_up_until: Date | null; locked_until: Date | null }>(
        'SELECT is_admin, step_up_until, locked_until FROM app.admin_console_state($1, $2)',
        [p.userId, p.sessionId],
      );
      return {
        isAdmin: row?.is_admin === true,
        stepUpUntil: row?.step_up_until ?? null,
        lockedUntil: row?.locked_until ?? null,
      };
    },

    async beginStepUp(p, correlationId) {
      const [row] = await query<{ id: string | null }>('SELECT app.admin_step_up_begin($1, $2, $3) AS id', [
        p.userId,
        p.sessionId,
        correlationId,
      ]);
      return row?.id ?? null;
    },

    async finishStepUp(p, attemptId, verified, correlationId) {
      const [row] = await query<{ until: Date | null }>(
        'SELECT app.admin_step_up_finish($1, $2, $3, $4, $5) AS until',
        [p.userId, p.sessionId, attemptId, verified, correlationId],
      );
      return row?.until ?? null;
    },

    async listWorkspaces(p, f, correlationId) {
      const rows = await query<{
        id: string;
        name: string;
        slug: string;
        status: AdminWorkspaceStatus;
        suspended_at: Date | null;
        deletion_scheduled: boolean;
        created_at: Date;
        member_count: number;
        project_count: number;
      }>('SELECT * FROM app.admin_list_workspaces($1, $2, $3, $4, $5, $6, $7)', [
        p.userId,
        p.sessionId,
        f.query,
        f.status,
        f.before,
        f.limit,
        correlationId,
      ]);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        suspendedAt: r.suspended_at,
        deletionScheduled: r.deletion_scheduled,
        createdAt: r.created_at,
        memberCount: r.member_count,
        projectCount: r.project_count,
      }));
    },

    async getWorkspace(p, workspaceId, correlationId) {
      const [r] = await query<{
        id: string;
        name: string;
        slug: string;
        status: AdminWorkspaceStatus;
        suspended_at: Date | null;
        suspended_reason: string | null;
        deletion_scheduled_at: Date | null;
        created_at: Date;
        member_count: number;
        owners: Array<{ userId: string; email: string }>;
        projects: Array<{ id: string; status: string; hosts: string[] }>;
      }>('SELECT * FROM app.admin_get_workspace($1, $2, $3, $4)', [
        p.userId,
        p.sessionId,
        workspaceId,
        correlationId,
      ]);
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        suspendedAt: r.suspended_at,
        suspendedReason: r.suspended_reason,
        deletionScheduledAt: r.deletion_scheduled_at,
        createdAt: r.created_at,
        memberCount: r.member_count,
        owners: r.owners,
        projects: r.projects,
      };
    },

    async listUsers(p, f, correlationId) {
      const rows = await query<{
        id: string;
        email_masked: string;
        status: AdminUserRow['status'];
        email_verified: boolean;
        two_factor_enabled: boolean;
        created_at: Date;
        workspace_count: number;
        platform_admin: boolean;
      }>('SELECT * FROM app.admin_list_users($1, $2, $3, $4, $5, $6)', [
        p.userId,
        p.sessionId,
        f.query,
        f.before,
        f.limit,
        correlationId,
      ]);
      return rows.map((r) => ({
        id: r.id,
        emailMasked: r.email_masked,
        status: r.status,
        emailVerified: r.email_verified,
        twoFactorEnabled: r.two_factor_enabled,
        createdAt: r.created_at,
        workspaceCount: r.workspace_count,
        platformAdmin: r.platform_admin,
      }));
    },

    async listAudit(p, f) {
      const rows = await query<{
        id: string;
        created_at: Date;
        workspace_id: string | null;
        actor_type: string;
        actor_id: string | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        result: AdminAuditRow['result'];
        correlation_id: string | null;
        metadata: Record<string, unknown>;
      }>('SELECT * FROM app.admin_list_audit($1, $2, $3, $4, $5, $6)', [
        p.userId,
        p.sessionId,
        f.action,
        f.actorId,
        f.before,
        f.limit,
      ]);
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        workspaceId: r.workspace_id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        result: r.result,
        correlationId: r.correlation_id,
        metadata: r.metadata,
      }));
    },

    async setWorkspaceStatus(p, input, correlationId) {
      const [row] = await query<{ changed: boolean; outbox_ids: string[] }>(
        'SELECT changed, outbox_ids FROM app.admin_set_workspace_status($1, $2, $3, $4, $5, $6)',
        [p.userId, p.sessionId, input.workspaceId, input.status, input.reason, correlationId],
      );
      return { changed: row?.changed === true, outboxIds: row?.outbox_ids ?? [] };
    },

    async verifyRole() {
      const [row] = await query<{ usr: string; su: boolean; bypass: boolean }>(
        'SELECT current_user AS usr, rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
        [],
      );
      if (!row || row.usr !== 'app_admin') {
        throw new UnsafeRoleError(
          `database connection must use role app_admin, got ${row?.usr ?? 'unknown'}`,
        );
      }
      if (row.su || row.bypass) throw new UnsafeRoleError('app_admin must not be SUPERUSER or BYPASSRLS');
    },

    close() {
      return pool.end();
    },
  };
}
