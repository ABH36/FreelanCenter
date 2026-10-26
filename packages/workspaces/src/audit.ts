/**
 * Workspace audit-log viewer and export (FR-AUD-01: "workspace owners can view/export theirs"; capability
 * `audit.view`, owner only, S5 decision D3). Reads go through RLS, so only the current workspace's rows are
 * visible; platform events (workspace_id NULL) never are. IP and user agent are not shown (data minimisation).
 * An export is itself an audited action. CSV cells are protected against formula injection.
 */
import { type Prisma, type TenantDatabase, type Tx, isUuid } from '@platform/db';
import type { Logger } from '@platform/logger';
import { createScopedRunner, requireId } from './scoped';

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

export interface AuditFilters {
  /** Prefix of the action name, e.g. `project.` or `workspace.member`. */
  action?: unknown;
  result?: unknown;
  actorId?: unknown;
  /** Inclusive UTC dates, YYYY-MM-DD. */
  from?: unknown;
  to?: unknown;
  cursor?: unknown;
}

export interface AuditEntryRow {
  id: string;
  createdAt: Date;
  action: string;
  result: 'success' | 'failure' | 'denied';
  actorType: string;
  actorId: string | null;
  /** Current members only; a former member shows as their id. */
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateBound(value: unknown, endOfDay: boolean): Date | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return endOfDay ? new Date(d.getTime() + 86_400_000) : d;
}

/** Normalized filters: anything malformed is dropped, never passed to the database. */
export function parseAuditFilters(filters: AuditFilters) {
  const action =
    typeof filters.action === 'string' && /^[a-z][a-z0-9_.]{0,99}$/.test(filters.action.trim())
      ? filters.action.trim()
      : null;
  const result: AuditEntryRow['result'] | null =
    filters.result === 'success' || filters.result === 'failure' || filters.result === 'denied'
      ? filters.result
      : null;
  const actorId = typeof filters.actorId === 'string' && isUuid(filters.actorId) ? filters.actorId : null;
  return { action, result, actorId, from: dateBound(filters.from, false), to: dateBound(filters.to, true) };
}

function whereFor(f: ReturnType<typeof parseAuditFilters>, cursor: string | null): Prisma.AuditLogWhereInput {
  return {
    ...(f.action ? { action: { startsWith: f.action } } : {}),
    ...(f.result ? { result: f.result } : {}),
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.from || f.to
      ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }
      : {}),
    ...(cursor ? { id: { lt: cursor } } : {}),
  };
}

const SELECT = {
  id: true,
  createdAt: true,
  action: true,
  result: true,
  actorType: true,
  actorId: true,
  targetType: true,
  targetId: true,
  projectId: true,
  correlationId: true,
  metadata: true,
} as const satisfies Prisma.AuditLogSelect;

async function memberNames(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<Array<{ user_id: string; name: string }>>`
    SELECT user_id, name FROM app.workspace_members()`;
  return new Map(rows.map((r) => [r.user_id, r.name]));
}

/** RFC 4180 cell; a leading = + - @ tab or CR is neutralised so spreadsheets do not run it as a formula. */
export function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_COLUMNS = [
  'created_at',
  'action',
  'result',
  'actor_type',
  'actor_id',
  'actor_name',
  'target_type',
  'target_id',
  'project_id',
  'correlation_id',
  'metadata',
] as const;

export function toCsv(rows: readonly AuditEntryRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt.toISOString(),
        r.action,
        r.result,
        r.actorType,
        r.actorId,
        r.actorName,
        r.targetType,
        r.targetId,
        r.projectId,
        r.correlationId,
        r.metadata,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function createAuditService(deps: { db: TenantDatabase; logger?: Logger }) {
  const { query, command } = createScopedRunner(deps.db, deps.logger);

  async function read(tx: Tx, filters: AuditFilters, take: number) {
    const f = parseAuditFilters(filters);
    const cursor = typeof filters.cursor === 'string' && filters.cursor ? requireId(filters.cursor) : null;
    // Sequential: one interactive transaction is one connection.
    const rows = await tx.auditLog.findMany({
      where: whereFor(f, cursor),
      orderBy: { id: 'desc' },
      take,
      select: SELECT,
    });
    const names = await memberNames(tx);
    return {
      filters: f,
      rows: rows.map((r): AuditEntryRow => ({
        ...r,
        actorName: r.actorId ? (names.get(r.actorId) ?? null) : null,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      })),
    };
  }

  return {
    async listAuditLog(
      actorUserId: string,
      workspaceId: unknown,
      filters: AuditFilters = {},
    ): Promise<{ items: AuditEntryRow[]; nextCursor: string | null }> {
      return query(actorUserId, workspaceId, 'audit.view', async (tx) => {
        const { rows } = await read(tx, filters, AUDIT_PAGE_SIZE + 1);
        const items = rows.slice(0, AUDIT_PAGE_SIZE);
        return { items, nextCursor: rows.length > AUDIT_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null };
      });
    },

    /** Up to AUDIT_EXPORT_MAX_ROWS rows, newest first. Allowed while suspended: it changes no tenant data. */
    async exportAuditLog(actorUserId: string, input: { workspaceId: unknown; filters?: AuditFilters }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'workspace.audit.exported', capability: 'audit.view', requireWritable: false },
        async (tx, scope) => {
          const { rows, filters } = await read(
            tx,
            { ...input.filters, cursor: undefined },
            AUDIT_EXPORT_MAX_ROWS + 1,
          );
          const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
          const exported = rows.slice(0, AUDIT_EXPORT_MAX_ROWS);
          return {
            result: { csv: toCsv(exported), rows: exported.length, truncated },
            audit: {
              targetType: 'workspace',
              targetId: scope.workspaceId,
              metadata: {
                rows: exported.length,
                truncated,
                action_prefix: filters.action,
                result: filters.result,
                actor_id: filters.actorId,
                from: filters.from?.toISOString() ?? null,
                to: filters.to?.toISOString() ?? null,
              },
            },
          };
        },
      );
    },

    /** Failed background jobs (ADR-007 rule 4), shown to owners next to the audit log. */
    async listDeadLetters(actorUserId: string, workspaceId: unknown) {
      return query(actorUserId, workspaceId, 'audit.view', (tx) =>
        tx.jobDeadLetter.findMany({
          orderBy: { id: 'desc' },
          take: 20,
          select: {
            id: true,
            createdAt: true,
            functionId: true,
            event: true,
            targetType: true,
            targetId: true,
            error: true,
          },
        }),
      );
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
