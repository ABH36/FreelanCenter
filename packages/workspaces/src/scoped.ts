/**
 * The command/query pattern every workspace-scoped service shares (S5, extended in S6): the browser's workspace id
 * is only a selector, turned into a TenantScope by a membership check; the capability is authorized with
 * `authorize()` semantics before any resource lookup; the mutation and its audit row commit in one RLS
 * transaction. "Not yours" and "does not exist" give the same NOT_FOUND (IDOR); a refusal is audited as `denied`.
 */
import { type Actor, type Capability, can } from '@platform/auth/rbac';
import { type TenantDatabase, type TenantScope, type Tx, isUuid } from '@platform/db';
import { type Logger, getLogContext } from '@platform/logger';
import type { z } from 'zod';
import { WorkspaceError, translate } from './errors';

export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  targetType: string;
  targetId: string;
  /** Filled for project-scoped events (audit_logs.project_id). */
  projectId?: string;
  metadata?: AuditMetadata;
}

export interface CommandSpec {
  action: string;
  capability: Capability;
  /** Default true: suspended or deletion-scheduled workspaces refuse the command (FR-WS-04). */
  requireWritable?: boolean;
}

export interface CommandResult<T> {
  result: T;
  /** null: nothing changed (idempotent repeat), so no audit row. */
  audit: AuditEntry | null;
}

export const memberActor = (scope: TenantScope): Actor => ({
  kind: 'member',
  userId: scope.actorUserId,
  workspaceId: scope.workspaceId,
  role: scope.role,
});

export const correlationId = () => getLogContext()?.correlationId ?? null;

export function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = [field, ...issue.path].join('.');
    fieldErrors[key] ??= issue.message;
  }
  throw new WorkspaceError('INVALID_INPUT', fieldErrors);
}

/** A browser-supplied id: anything that is not a UUID is simply not found. */
export function requireId(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new WorkspaceError('NOT_FOUND');
  return value;
}

export async function writeAudit(
  tx: Tx,
  scope: TenantScope,
  action: string,
  audit: AuditEntry,
  result: 'success' | 'denied' = 'success',
): Promise<void> {
  await tx.auditLog.createMany({
    data: [
      {
        workspaceId: scope.workspaceId,
        projectId: audit.projectId ?? null,
        actorType: 'user',
        actorId: scope.actorUserId,
        action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        result,
        correlationId: correlationId(),
        metadata: audit.metadata ?? {},
      },
    ],
  });
}

export function createScopedRunner(db: TenantDatabase, logger?: Logger) {
  async function scopeFor(actorUserId: string, workspaceId: unknown): Promise<TenantScope> {
    const id = requireId(workspaceId);
    const scope = await db.resolveTenantScope(actorUserId, id);
    if (!scope) throw new WorkspaceError('NOT_FOUND');
    return scope;
  }

  /** A refused command is evidence too (module 01: role/owner changes are auditable). */
  async function denied(scope: TenantScope, action: string, capability: Capability): Promise<never> {
    await db
      .withTenant(scope, (tx) =>
        writeAudit(
          tx,
          scope,
          action,
          { targetType: 'workspace', targetId: scope.workspaceId, metadata: { capability } },
          'denied',
        ),
      )
      .catch((error: unknown) => logger?.error('workspace.audit.denied_write_failed', error, { action }));
    throw new WorkspaceError('FORBIDDEN');
  }

  async function command<T>(
    actorUserId: string,
    workspaceId: unknown,
    spec: CommandSpec,
    fn: (tx: Tx, scope: TenantScope) => Promise<CommandResult<T>>,
  ): Promise<T> {
    const scope = await scopeFor(actorUserId, workspaceId);
    if (!can(memberActor(scope), spec.capability, { workspaceId: scope.workspaceId })) {
      return denied(scope, spec.action, spec.capability);
    }
    if (spec.requireWritable !== false && !scope.writable) throw new WorkspaceError('NOT_WRITABLE');
    try {
      return await db.withTenant(scope, async (tx) => {
        const { result, audit } = await fn(tx, scope);
        if (audit) await writeAudit(tx, scope, spec.action, audit);
        return result;
      });
    } catch (error) {
      return translate(error);
    }
  }

  /** Read-only query under a capability; no audit row. */
  async function query<T>(
    actorUserId: string,
    workspaceId: unknown,
    capability: Capability,
    fn: (tx: Tx, scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    const scope = await scopeFor(actorUserId, workspaceId);
    if (!can(memberActor(scope), capability, { workspaceId: scope.workspaceId })) {
      throw new WorkspaceError('FORBIDDEN');
    }
    try {
      return await db.withTenant(scope, (tx) => fn(tx, scope));
    } catch (error) {
      return translate(error);
    }
  }

  return { scopeFor, denied, command, query };
}

export type ScopedRunner = ReturnType<typeof createScopedRunner>;
