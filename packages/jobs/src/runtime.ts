/**
 * The only place that talks to Inngest (ADR-007 rule 3: events are emitted through typed, ids-only helpers;
 * ESLint forbids importing `inngest` anywhere else). Spike G proved every option used here: retry with backoff,
 * function idempotency on a domain id, per-workspace concurrency, `onFailure` as the dead-letter hook and
 * signed requests in cloud mode.
 */
import { Inngest, NonRetriableError } from 'inngest';
import { serve } from 'inngest/next';
import type { JobsConfig } from './config';
import { EVENTS, type InvitationCreated, parseInvitationCreated } from './events';

export const APP_ID = 'platform-dashboard';
export const SERVE_PATH = '/api/inngest';
export const INVITATION_EMAIL_FUNCTION = {
  id: 'invitation-email-v1',
  name: 'workspace.invitation.email.v1',
  retries: 3,
  /** Per workspace: one tenant inviting in bulk cannot hold every worker (Spike G G12). */
  concurrencyPerWorkspace: 2,
} as const;

export interface DeadLetter {
  /** null when the payload itself was invalid (no ids to attach it to). */
  ids: InvitationCreated | null;
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

export interface JobEmitter {
  invitationCreated(ids: InvitationCreated): Promise<void>;
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

/** Production path: signed events to Inngest, functions served at `/api/inngest`. */
export function createInngestJobs(
  config: JobsConfig,
  handlers: { invitationEmail: InvitationEmailHandler },
  /** Tests only: the origin a containerised executor uses to reach this process (default: from the request). */
  options: { serveOrigin?: string } = {},
): Jobs {
  const client = createInngestClient(config);
  const functions = [createInvitationEmailFunction(client, handlers.invitationEmail)];
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
    },
    route: {
      GET: route.GET as RouteHandler,
      POST: route.POST as RouteHandler,
      PUT: route.PUT as RouteHandler,
    },
  };
}

/**
 * Local development and tests: the same handler, in-process, after the response; one attempt, then the
 * dead-letter hook. `loadJobsConfig` refuses this transport on any deployment.
 */
export function createInlineJobs(handlers: { invitationEmail: InvitationEmailHandler }, defer: Defer): Jobs {
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
    },
    route: null,
  };
}

export function createJobs(
  config: JobsConfig,
  handlers: { invitationEmail: InvitationEmailHandler },
  defer: Defer,
): Jobs {
  return config.transport === 'inngest'
    ? createInngestJobs(config, handlers)
    : createInlineJobs(handlers, defer);
}
