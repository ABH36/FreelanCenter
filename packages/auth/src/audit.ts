/**
 * Platform audit events for authentication (FR-AUD-01). Identity events have no workspace, so they are written
 * through the SECURITY DEFINER function `app.record_platform_audit`, the only path `app_auth` has into
 * `app.audit_logs` (migration p1_foundation, section 6). Metadata is redacted by construction: callers pass
 * reason codes and ids, never e-mail addresses, tokens or passwords.
 */
import { isIP } from 'node:net';
import type { Logger } from '@platform/logger';

export type AuthAuditAction =
  | 'auth.user.created'
  | 'auth.email.verified'
  | 'auth.session.created'
  | 'auth.session.revoked'
  | 'auth.sessions.revoked_all'
  | 'auth.sign_in.failed'
  | 'auth.sign_in.blocked'
  | 'auth.password.reset_requested'
  | 'auth.password.reset'
  | 'auth.password.changed'
  | 'auth.mfa.enabled'
  | 'auth.mfa.disabled'
  | 'auth.mfa.challenge_failed'
  | 'auth.oauth.linked';

export interface AuthAuditEvent {
  action: AuthAuditAction;
  result: 'success' | 'failure' | 'denied';
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditWriter {
  /** Resolves to the audit row id, or null when the insert failed (logged, never thrown). */
  record(event: AuthAuditEvent): Promise<string | null>;
}

/** The subset of a Prisma client this module needs, so tests can substitute it. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

const USER_AGENT_MAX = 512;

export function createAuditWriter(db: RawQueryClient, logger?: Logger): AuditWriter {
  return {
    async record(event) {
      const ip = event.ip && isIP(event.ip) ? event.ip : null;
      const userAgent = event.userAgent ? event.userAgent.slice(0, USER_AGENT_MAX) : null;
      try {
        const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT app.record_platform_audit(
          ${event.actorUserId ? 'user' : 'system'}::app.audit_actor_type,
          ${event.actorUserId ?? null}::uuid,
          ${event.action},
          ${event.targetType ?? (event.targetId ? 'user' : null)},
          ${event.targetId ?? null},
          ${event.result}::app.audit_result,
          ${event.correlationId ?? null},
          ${JSON.stringify(event.metadata ?? {})}::jsonb,
          ${ip}::inet,
          ${userAgent}
        ) AS id`;
        return rows[0]?.id ?? null;
      } catch (error) {
        // Auth must stay available when the audit insert fails, but the gap must be visible: error level
        // pages on-call once Sentry is wired (S9). The event itself is logged so it can be replayed.
        logger?.error('auth.audit.write_failed', error, {
          action: event.action,
          result: event.result,
          actorUserId: event.actorUserId ?? null,
        });
        return null;
      }
    },
  };
}
