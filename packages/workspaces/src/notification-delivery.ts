/**
 * The notification e-mail job handler (FR-NOT-01, ADR-007). Runs inside `notification.email.v1` (or the inline
 * transport locally). The event carries ids only; the handler reloads the notification through
 * `app.notification_delivery` in a job scope (workspace context, no actor), re-checks the recipient's e-mail
 * choice, and sends at most one e-mail per notification (provider idempotency key). Capture transport until DG-10.
 */
import { createHash } from 'node:crypto';
import type { TenantDatabase } from '@platform/db';
import type { NotificationEmailHandler } from '@platform/jobs';
import { type Logger, redactString } from '@platform/logger';
import type { EmailProvider } from '@platform/providers';
import { renderNotificationMail } from './mail';
import { categoryOf, emailWanted } from './notifications';

export const NOTIFICATION_MAIL_KIND = 'workspace.notification';

export interface NotificationDeliveryDeps {
  db: TenantDatabase;
  email: EmailProvider;
  baseURL: string;
  appName: string;
  logger?: Logger;
}

export function createNotificationEmailHandler(deps: NotificationDeliveryDeps): NotificationEmailHandler {
  return {
    async deliver({ workspaceId, notificationId }) {
      const found = await deps.db.withJobTenant(workspaceId, async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            recipient_email: string;
            type: string;
            payload: Record<string, unknown>;
            email_choices: Record<string, boolean>;
            workspace_name: string;
          }>
        >`SELECT recipient_email, type, payload, email_choices, workspace_name
            FROM app.notification_delivery(${notificationId}::uuid)`;
        const row = rows[0];
        if (!row) return null;
        const projectId = typeof row.payload.projectId === 'string' ? row.payload.projectId : null;
        const project = projectId
          ? await tx.project.findFirst({ where: { id: projectId }, select: { name: true } })
          : null;
        const workspace = await tx.workspace.findFirst({
          where: { id: workspaceId },
          select: { slug: true },
        });
        return { ...row, projectName: project?.name ?? null, slug: workspace?.slug ?? null };
      });
      const category = found ? categoryOf(found.type) : null;
      if (!found || !category || !emailWanted(category, found.email_choices[category])) {
        deps.logger?.info('notification.email_skipped', { workspaceId, notificationId });
        return 'skipped';
      }
      const rendered = renderNotificationMail(
        {
          type: found.type,
          workspaceName: found.workspace_name,
          projectName: found.projectName,
          payload: found.payload,
          url: found.slug ? `${deps.baseURL}/w/${found.slug}/notifications` : deps.baseURL,
        },
        deps.appName,
      );
      await deps.email.send({
        to: found.recipient_email,
        kind: NOTIFICATION_MAIL_KIND,
        ...rendered,
        idempotencyKey: createHash('sha256')
          .update(`${NOTIFICATION_MAIL_KIND}:${notificationId}`)
          .digest('hex'),
      });
      deps.logger?.info('notification.email_sent', {
        workspaceId,
        notificationId,
        provider: deps.email.name,
      });
      return 'sent';
    },

    async deadLetter({ ids, functionId, runId, error }) {
      deps.logger?.error('job.dead_lettered', undefined, {
        functionId,
        runId,
        workspaceId: ids?.workspaceId ?? null,
        notificationId: ids?.notificationId ?? null,
      });
      if (!ids) return;
      await deps.db.withJobTenant(ids.workspaceId, (tx) =>
        tx.jobDeadLetter.createMany({
          data: [
            {
              workspaceId: ids.workspaceId,
              functionId,
              runId: runId.slice(0, 64),
              event: 'notification.email.requested.v1',
              targetType: 'notification',
              targetId: ids.notificationId,
              error: redactString(error).slice(0, 300),
            },
          ],
        }),
      );
    },
  };
}
