import { Inngest, NonRetriableError } from 'inngest';
import { EVENT_KEY, INNGEST_BASE_URL, SIGNING_KEY } from './keys';
import type { World } from './world';

export const NOTIFICATION_EMAIL_EVENT = 'notification/email.requested';
export const RETRIES = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NotificationEmailIds {
  workspaceId: string;
  notificationId: string;
}

/**
 * Event payloads carry identifiers only (privacy inventory: Inngest is a cross-border processor that
 * stores payloads). Anything else is rejected, at the sender and again inside the function.
 */
export function parseIdsOnly(data: unknown): NotificationEmailIds {
  if (data === null || typeof data !== 'object') throw new Error('payload must be an object');
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== 'notificationId,workspaceId') {
    throw new Error(`payload must contain exactly {workspaceId, notificationId}; got {${keys.join(', ')}}`);
  }
  const { workspaceId, notificationId } = data as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new Error('workspaceId must be a UUID');
  }
  if (typeof notificationId !== 'string' || !UUID.test(notificationId)) {
    throw new Error('notificationId must be a UUID');
  }
  return { workspaceId, notificationId };
}

/**
 * Cloud-mode client. `isDev: false` is set explicitly: the SDK skips signature verification whenever it
 * is in dev mode, and dev mode can otherwise be switched on by the INNGEST_DEV environment variable.
 */
export function createClient(overrides: { isDev?: boolean; signingKey?: string } = {}) {
  return new Inngest({
    id: 'spike-g',
    isDev: overrides.isDev ?? false,
    baseUrl: INNGEST_BASE_URL,
    eventKey: EVENT_KEY,
    signingKey: overrides.signingKey ?? SIGNING_KEY,
  });
}

export type Client = ReturnType<typeof createClient>;

/** The only way product code is meant to emit this event: validated, ids only, deterministic event id. */
export async function requestNotificationEmail(client: Client, ids: NotificationEmailIds) {
  const data = parseIdsOnly(ids);
  return client.send({
    id: `notification-email:${data.notificationId}`,
    name: NOTIFICATION_EMAIL_EVENT,
    data,
  });
}

export function createNotificationEmailFn(client: Client, world: World) {
  return client.createFunction(
    {
      id: 'notification-email-v1',
      name: 'notification.email.v1',
      triggers: [{ event: NOTIFICATION_EMAIL_EVENT }],
      retries: RETRIES,
      // One run per notification for 24 h, whatever event id the sender used.
      idempotency: 'event.data.notificationId',
      // Per-workspace fairness: one workspace cannot occupy every worker.
      concurrency: [{ key: 'event.data.workspaceId', limit: 1 }],
      // Dead-letter: runs only after the last retry fails (or immediately on NonRetriableError).
      onFailure: async ({ event, error }) => {
        const original = event.data.event.data as Partial<NotificationEmailIds> | undefined;
        world.deadLetters.push({
          functionId: event.data.function_id,
          runId: event.data.run_id,
          workspaceId: original?.workspaceId,
          notificationId: original?.notificationId,
          error: error.message,
          at: new Date().toISOString(),
        });
        world.alerts.push(`job.dead_lettered notification-email-v1 run=${event.data.run_id}`);
      },
    },
    async ({ event, step, attempt, runId }) => {
      let ids: NotificationEmailIds;
      try {
        ids = parseIdsOnly(event.data);
      } catch (err) {
        throw new NonRetriableError((err as Error).message);
      }
      const row = await step.run('load-notification', () => world.load(ids.workspaceId, ids.notificationId));
      const sent = await step.run('send-email', () => world.send(row, ids.notificationId, attempt));
      await step.run('mark-sent', () => world.markSent(ids.notificationId));
      world.completedRuns.set(ids.notificationId, runId);
      return sent;
    },
  );
}
