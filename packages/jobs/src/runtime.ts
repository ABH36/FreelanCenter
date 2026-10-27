/**
 * The only place that talks to Inngest (ADR-007 rule 3: events are emitted through typed, ids-only helpers;
 * ESLint forbids importing `inngest` anywhere else). Spike G proved every option used here: retry with backoff,
 * function idempotency on a domain id, per-workspace concurrency, `onFailure` as the dead-letter hook and
 * signed requests in cloud mode. S6 adds the notification e-mail and the outbox sweep (a cron function); S7 the
 * host-cache invalidation for apps/sites.
 */
import { Inngest, NonRetriableError } from 'inngest';
import { serve } from 'inngest/next';
import type { JobsConfig } from './config';
import {
  EVENTS,
  type InvitationCreated,
  type NotificationEmailRequested,
  type SiteHostsChanged,
  parseInvitationCreated,
  parseNotificationEmailRequested,
  parseSiteHostsChanged,
} from './events';

export const APP_ID = 'platform-dashboard';
export const SERVE_PATH = '/api/inngest';
export const INVITATION_EMAIL_FUNCTION = {
  id: 'invitation-email-v1',
  name: 'workspace.invitation.email.v1',
  retries: 3,
  /** Per workspace: one tenant inviting in bulk cannot hold every worker (Spike G G12). */
  concurrencyPerWorkspace: 2,
} as const;
export const NOTIFICATION_EMAIL_FUNCTION = {
  id: 'notification-email-v1',
  name: 'notification.email.v1',
  retries: 3,
  concurrencyPerWorkspace: 5,
} as const;
/**
 * Drops the cached host resolutions of one project (FR-DOM-07). No idempotency key on purpose: every status
 * change must invalidate again, and a repeated run only deletes keys that are already gone. A duplicate emit of
 * the same outbox row is de-duplicated by its event id.
 */
export const HOST_CACHE_INVALIDATION_FUNCTION = {
  id: 'site-host-cache-invalidate-v1',
  name: 'sites.host_cache.invalidate.v1',
  retries: 5,
  concurrencyPerWorkspace: 5,
} as const;
/** Re-emits outbox events whose emit after commit was lost (cross-module contracts; S5 decision D4). */
export const OUTBOX_SWEEP_FUNCTION = {
  id: 'outbox-sweep-v1',
  name: 'outbox.sweep.v1',
  cron: '*/5 * * * *',
  retries: 1,
} as const;

export interface DeadLetter<I = InvitationCreated> {
  /** null when the payload itself was invalid (no ids to attach it to). */
  ids: I | null;
  functionId: string;
  runId: string;
  error: string;
}

export interface InvitationEmailHandler {
  /** Idempotent (G-2/G-3): at most one delivery per invitation; `skipped` once it is no longer open. */
  deliver(ids: InvitationCreated): Promise<'sent' | 'skipped'>;
  /** G-5: Inngest keeps no dead-letter store, so this writes a durable workspace-scoped record and alerts. */
  deadLetter(failure: DeadLetter): Promise<void>;
}

export interface NotificationEmailHandler {
  /** Idempotent: at most one e-mail per notification; `skipped` when the recipient no longer wants or can get it. */
  deliver(ids: NotificationEmailRequested): Promise<'sent' | 'skipped'>;
  deadLetter(failure: DeadLetter<NotificationEmailRequested>): Promise<void>;
}

export interface HostCacheInvalidationHandler {
  /** Deletes the cache entries of every host name the project has or had; returns how many host names. */
  invalidate(ids: SiteHostsChanged): Promise<{ hosts: number }>;
  deadLetter(failure: DeadLetter<SiteHostsChanged>): Promise<void>;
}

export interface OutboxSweeper {
  sweep(): Promise<{ dispatched: number; failed: number }>;
}

export interface JobHandlers {
  invitationEmail: InvitationEmailHandler;
  /** Optional so a process that sends no notification e-mail (some test suites) need not wire one. */
  notificationEmail?: NotificationEmailHandler;
  outboxSweep?: OutboxSweeper;
  hostCacheInvalidation?: HostCacheInvalidationHandler;
}

export interface JobEmitter {
  invitationCreated(ids: InvitationCreated): Promise<void>;
  /** `eventId` is the outbox row id: a repeated emit of the same row is de-duplicated by Inngest. */
  notificationEmailRequested(ids: NotificationEmailRequested, options: { eventId: string }): Promise<void>;
  /** `eventId` is the outbox row id, as above. */
  siteHostsChanged(ids: SiteHostsChanged, options: { eventId: string }): Promise<void>;
}

export type RouteHandler = (request: Request) => Promise<Response>;

export interface Jobs {
  emitter: JobEmitter;
  /** The `/api/inngest` route handlers; null for the inline transport (nothing to serve). */
  route: { GET: RouteHandler; POST: RouteHandler; PUT: RouteHandler } | null;
}

/** Runs work after the response is sent (Next `after()`); used by the inline transport. */
export type Defer = (task: () => Promise<void>) => void;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function createInngestClient(config: JobsConfig): Inngest {
  return new Inngest({
    id: APP_ID,
    isDev: config.isDev,
    eventKey: config.eventKey,
    signingKey: config.signingKey,
    baseUrl: config.baseUrl,
  });
}

export function createInvitationEmailFunction(client: Inngest, handler: InvitationEmailHandler) {
  return client.createFunction(
    {
      id: INVITATION_EMAIL_FUNCTION.id,
      name: INVITATION_EMAIL_FUNCTION.name,
      triggers: [{ event: EVENTS.invitationCreated }],
      retries: INVITATION_EMAIL_FUNCTION.retries,
      // One run per invitation for 24 h, whatever event id a sender used.
      idempotency: 'event.data.invitationId',
      concurrency: [
        { key: 'event.data.workspaceId', limit: INVITATION_EMAIL_FUNCTION.concurrencyPerWorkspace },
      ],
      onFailure: async ({ event, error }) => {
        let ids: InvitationCreated | null;
        try {
          ids = parseInvitationCreated(event.data.event.data);
        } catch {
          ids = null;
        }
        await handler.deadLetter({
          ids,
          functionId: INVITATION_EMAIL_FUNCTION.id,
          runId: String(event.data.run_id),
          error: errorMessage(error),
        });
      },
    },
    async ({ event, step }) => {
      let ids: InvitationCreated;
      try {
        ids = parseInvitationCreated(event.data);
      } catch (error) {
        throw new NonRetriableError(errorMessage(error));
      }
      return step.run('send-invitation-email', () => handler.deliver(ids));
    },
  );
}

export function createNotificationEmailFunction(client: Inngest, handler: NotificationEmailHandler) {
  return client.createFunction(
    {
      id: NOTIFICATION_EMAIL_FUNCTION.id,
      name: NOTIFICATION_EMAIL_FUNCTION.name,
      triggers: [{ event: EVENTS.notificationEmailRequested }],
      retries: NOTIFICATION_EMAIL_FUNCTION.retries,
      idempotency: 'event.data.notificationId',
      concurrency: [
        { key: 'event.data.workspaceId', limit: NOTIFICATION_EMAIL_FUNCTION.concurrencyPerWorkspace },
      ],
      onFailure: async ({ event, error }) => {
        let ids: NotificationEmailRequested | null;
        try {
          ids = parseNotificationEmailRequested(event.data.event.data);
        } catch {
          ids = null;
        }
        await handler.deadLetter({
          ids,
          functionId: NOTIFICATION_EMAIL_FUNCTION.id,
          runId: String(event.data.run_id),
          error: errorMessage(error),
        });
      },
    },
    async ({ event, step }) => {
      let ids: NotificationEmailRequested;
      try {
        ids = parseNotificationEmailRequested(event.data);
      } catch (error) {
        throw new NonRetriableError(errorMessage(error));
      }
      return step.run('send-notification-email', () => handler.deliver(ids));
    },
  );
}

export function createHostCacheInvalidationFunction(client: Inngest, handler: HostCacheInvalidationHandler) {
  return client.createFunction(
    {
      id: HOST_CACHE_INVALIDATION_FUNCTION.id,
      name: HOST_CACHE_INVALIDATION_FUNCTION.name,
      triggers: [{ event: EVENTS.siteHostsChanged }],
      retries: HOST_CACHE_INVALIDATION_FUNCTION.retries,
      concurrency: [
        { key: 'event.data.workspaceId', limit: HOST_CACHE_INVALIDATION_FUNCTION.concurrencyPerWorkspace },
      ],
      onFailure: async ({ event, error }) => {
        let ids: SiteHostsChanged | null;
        try {
          ids = parseSiteHostsChanged(event.data.event.data);
        } catch {
          ids = null;
        }
        await handler.deadLetter({
          ids,
          functionId: HOST_CACHE_INVALIDATION_FUNCTION.id,
          runId: String(event.data.run_id),
          error: errorMessage(error),
        });
      },
    },
    async ({ event, step }) => {
      let ids: SiteHostsChanged;
      try {
        ids = parseSiteHostsChanged(event.data);
      } catch (error) {
        throw new NonRetriableError(errorMessage(error));
      }
      return step.run('invalidate-host-cache', () => handler.invalidate(ids));
    },
  );
}

export function createOutboxSweepFunction(client: Inngest, sweeper: OutboxSweeper) {
  return client.createFunction(
    {
      id: OUTBOX_SWEEP_FUNCTION.id,
      name: OUTBOX_SWEEP_FUNCTION.name,
      triggers: [{ cron: OUTBOX_SWEEP_FUNCTION.cron }],
      retries: OUTBOX_SWEEP_FUNCTION.retries,
      // One sweep at a time across the app: overlapping sweeps would only emit the same rows twice.
      concurrency: [{ limit: 1 }],
    },
    async ({ step }) => step.run('sweep-outbox', () => sweeper.sweep()),
  );
}

/** Production path: signed events to Inngest, functions served at `/api/inngest`. */
export function createInngestJobs(
  config: JobsConfig,
  handlers: JobHandlers,
  /** Tests only: the origin a containerised executor uses to reach this process (default: from the request). */
  options: { serveOrigin?: string } = {},
): Jobs {
  const client = createInngestClient(config);
  const functions = [
    createInvitationEmailFunction(client, handlers.invitationEmail),
    ...(handlers.notificationEmail
      ? [createNotificationEmailFunction(client, handlers.notificationEmail)]
      : []),
    ...(handlers.outboxSweep ? [createOutboxSweepFunction(client, handlers.outboxSweep)] : []),
    ...(handlers.hostCacheInvalidation
      ? [createHostCacheInvalidationFunction(client, handlers.hostCacheInvalidation)]
      : []),
  ];
  const route = serve({ client, functions, servePath: SERVE_PATH, serveOrigin: options.serveOrigin });
  return {
    emitter: {
      async invitationCreated(ids) {
        const data = parseInvitationCreated(ids);
        // Deterministic event id: a retried emit for the same invitation is de-duplicated by Inngest.
        await client.send({
          id: `invitation-email:${data.invitationId}`,
          name: EVENTS.invitationCreated,
          data,
        });
      },
      async notificationEmailRequested(ids, { eventId }) {
        const data = parseNotificationEmailRequested(ids);
        await client.send({ id: `outbox:${eventId}`, name: EVENTS.notificationEmailRequested, data });
      },
      async siteHostsChanged(ids, { eventId }) {
        const data = parseSiteHostsChanged(ids);
        await client.send({ id: `outbox:${eventId}`, name: EVENTS.siteHostsChanged, data });
      },
    },
    route: {
      GET: route.GET as RouteHandler,
      POST: route.POST as RouteHandler,
      PUT: route.PUT as RouteHandler,
    },
  };
}

/**
 * Local development and tests: the same handlers, in-process, after the response; one attempt, then the
 * dead-letter hook. There is no cron: the outbox sweep runs only when called. `loadJobsConfig` refuses this
 * transport on any deployment.
 */
export function createInlineJobs(handlers: JobHandlers, defer: Defer): Jobs {
  return {
    emitter: {
      async invitationCreated(ids) {
        const data = parseInvitationCreated(ids);
        defer(async () => {
          try {
            await handlers.invitationEmail.deliver(data);
          } catch (error) {
            await handlers.invitationEmail.deadLetter({
              ids: data,
              functionId: INVITATION_EMAIL_FUNCTION.id,
              runId: 'inline',
              error: errorMessage(error),
            });
          }
        });
      },
      async notificationEmailRequested(ids) {
        const data = parseNotificationEmailRequested(ids);
        const handler = handlers.notificationEmail;
        if (!handler) throw new Error('no notification e-mail handler is configured');
        defer(async () => {
          try {
            await handler.deliver(data);
          } catch (error) {
            await handler.deadLetter({
              ids: data,
              functionId: NOTIFICATION_EMAIL_FUNCTION.id,
              runId: 'inline',
              error: errorMessage(error),
            });
          }
        });
      },
      async siteHostsChanged(ids) {
        const data = parseSiteHostsChanged(ids);
        const handler = handlers.hostCacheInvalidation;
        if (!handler) throw new Error('no host-cache invalidation handler is configured');
        defer(async () => {
          try {
            await handler.invalidate(data);
          } catch (error) {
            await handler.deadLetter({
              ids: data,
              functionId: HOST_CACHE_INVALIDATION_FUNCTION.id,
              runId: 'inline',
              error: errorMessage(error),
            });
          }
        });
      },
    },
    route: null,
  };
}

export function createJobs(config: JobsConfig, handlers: JobHandlers, defer: Defer): Jobs {
  return config.transport === 'inngest'
    ? createInngestJobs(config, handlers)
    : createInlineJobs(handlers, defer);
}
