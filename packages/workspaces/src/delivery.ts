/**
 * The invitation e-mail job handler (FR-NOT-01, ADR-007). Runs inside the Inngest function
 * `workspace.invitation.email.v1` (or the inline transport locally). The event carries ids only; the handler
 * reloads the invitation through RLS in a job scope (`withJobTenant`: workspace context, no actor), so it can
 * read but not change membership data.
 */
import { createHash } from 'node:crypto';
import type { TenantDatabase } from '@platform/db';
import type { InvitationEmailHandler } from '@platform/jobs';
import { type Logger, redactString } from '@platform/logger';
import type { EmailProvider } from '@platform/providers';
import { renderInvitationMail } from './mail';
import { type InvitationKey, invitationToken } from './token';

export const INVITATION_MAIL_KIND = 'workspace.invitation';

export interface DeliveryDeps {
  db: TenantDatabase;
  email: EmailProvider;
  invitationKey: InvitationKey;
  baseURL: string;
  appName: string;
  logger?: Logger;
}

export function createInvitationEmailHandler(deps: DeliveryDeps): InvitationEmailHandler {
  return {
    async deliver({ workspaceId, invitationId }) {
      const invitation = await deps.db.withJobTenant(workspaceId, (tx) =>
        tx.invitation.findFirst({
          where: { id: invitationId },
          select: {
            email: true,
            role: true,
            expiresAt: true,
            acceptedAt: true,
            revokedAt: true,
            workspace: { select: { name: true, status: true, deletedAt: true } },
          },
        }),
      );
      const open =
        invitation &&
        !invitation.acceptedAt &&
        !invitation.revokedAt &&
        invitation.expiresAt.getTime() > Date.now() &&
        invitation.workspace.status === 'active' &&
        !invitation.workspace.deletedAt;
      if (!open) {
        deps.logger?.info('workspace.invitation.email_skipped', { workspaceId, invitationId });
        return 'skipped';
      }
      const rendered = renderInvitationMail(
        {
          workspaceName: invitation.workspace.name,
          role: invitation.role,
          url: `${deps.baseURL}/invite/${invitationToken(deps.invitationKey, invitationId)}`,
          expiresAt: invitation.expiresAt,
        },
        deps.appName,
      );
      await deps.email.send({
        to: invitation.email,
        kind: INVITATION_MAIL_KIND,
        ...rendered,
        // One delivery per invitation however often the step is retried (G-2/G-3).
        idempotencyKey: createHash('sha256').update(`${INVITATION_MAIL_KIND}:${invitationId}`).digest('hex'),
      });
      deps.logger?.info('workspace.invitation.email_sent', {
        workspaceId,
        invitationId,
        provider: deps.email.name,
      });
      return 'sent';
    },

    async deadLetter({ ids, functionId, runId, error }) {
      // G-5: the alert (error level, paged once Sentry lands in S9) and a durable, workspace-scoped record.
      deps.logger?.error('job.dead_lettered', undefined, {
        functionId,
        runId,
        workspaceId: ids?.workspaceId ?? null,
        invitationId: ids?.invitationId ?? null,
      });
      if (!ids) return;
      // S6: the operational record (job_dead_letters, S5 decision D5) and, as before, the audit evidence.
      await deps.db.withJobTenant(ids.workspaceId, async (tx) => {
        await tx.jobDeadLetter.createMany({
          data: [
            {
              workspaceId: ids.workspaceId,
              functionId,
              runId: runId.slice(0, 64),
              event: 'workspace.invitation.created.v1',
              targetType: 'invitation',
              targetId: ids.invitationId,
              error: redactString(error).slice(0, 300),
            },
          ],
        });
        await tx.auditLog.createMany({
          data: [
            {
              workspaceId: ids.workspaceId,
              actorType: 'job',
              action: 'jobs.invitation_email.dead_lettered',
              targetType: 'invitation',
              targetId: ids.invitationId,
              result: 'failure',
              metadata: {
                function_id: functionId,
                run_id: runId.slice(0, 64),
                error: redactString(error).slice(0, 300),
              },
            },
          ],
        });
      });
    },
  };
}
