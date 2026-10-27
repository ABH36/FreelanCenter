/**
 * The production job path end to end (ADR-007, P1 S5 invitation mail): our `createInngestJobs` serve handler,
 * synced to a local `inngest start` executor that signs every request (same executor as Inngest Cloud, Spike G).
 * Proves: delivery through a signed request, de-duplication of a repeated emit, retry after a failed attempt,
 * the dead-letter hook for a bad payload, and rejection of an unsigned call. S6 adds the notification e-mail, S7
 * the host-cache invalidation.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type DeadLetter,
  type InvitationCreated,
  type NotificationEmailRequested,
  SERVE_PATH,
  type SiteHostsChanged,
  createInngestClient,
  createInngestJobs,
} from '../src';

const PORT = 3941;
const BASE = 'http://localhost:8298';

const delivered: InvitationCreated[] = [];
const deadLetters: DeadLetter[] = [];
const notified: NotificationEmailRequested[] = [];
const invalidated: SiteHostsChanged[] = [];
/** Invitation ids whose first attempt must fail (retry test). */
const failOnce = new Set<string>();

const keys = inject('jobsKeys');
const config = {
  transport: 'inngest' as const,
  isDev: false,
  eventKey: keys.eventKey,
  signingKey: `signkey-test-${keys.signingKey}`,
  baseUrl: BASE,
};
const jobs = createInngestJobs(
  config,
  {
    invitationEmail: {
      async deliver(ids) {
        if (failOnce.delete(ids.invitationId)) throw new Error('provider temporarily unavailable');
        delivered.push(ids);
        return 'sent';
      },
      async deadLetter(failure) {
        deadLetters.push(failure);
      },
    },
    // S6: the notification e-mail function and the outbox sweep (cron) are served by the same app.
    notificationEmail: {
      async deliver(n) {
        notified.push(n);
        return 'sent';
      },
      async deadLetter() {},
    },
    outboxSweep: {
      async sweep() {
        return { dispatched: 0, failed: 0 };
      },
    },
    // S7: the host-cache invalidation for apps/sites.
    hostCacheInvalidation: {
      async invalidate(h) {
        invalidated.push(h);
        return { hosts: 1 };
      },
      async deadLetter() {},
    },
  },
  { serveOrigin: `http://host.docker.internal:${PORT}` },
);

let server: http.Server;

async function waitFor<T>(what: string, fn: () => T | undefined, timeoutMs = 100_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const ids = (): InvitationCreated => ({ workspaceId: randomUUID(), invitationId: randomUUID() });

beforeAll(async () => {
  const route = jobs.route!;
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const method = (req.method ?? 'GET') as 'GET' | 'POST' | 'PUT';
    // The executor reaches this host as host.docker.internal; the registered URL is derived from the request.
    const request = new Request(`http://host.docker.internal:${PORT}${req.url}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : Buffer.concat(chunks),
    });
    const response = req.url?.startsWith(SERVE_PATH)
      ? await route[method](request)
      : new Response(null, { status: 404 });
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  // Sync the app (register its functions) with the executor.
  const sync = await fetch(`http://localhost:${PORT}${SERVE_PATH}`, { method: 'PUT' });
  expect(sync.status).toBe(200);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('invitation e-mail through the signed executor', () => {
  it('an emitted event is delivered with exactly the ids', async () => {
    const event = ids();
    await jobs.emitter.invitationCreated(event);
    await waitFor('delivery', () => delivered.find((d) => d.invitationId === event.invitationId));
    expect(delivered.filter((d) => d.invitationId === event.invitationId)).toEqual([event]);
  });

  it('a repeated emit for the same invitation is delivered once', async () => {
    const event = ids();
    await jobs.emitter.invitationCreated(event);
    await jobs.emitter.invitationCreated(event);
    await waitFor('delivery', () => delivered.find((d) => d.invitationId === event.invitationId));
    await new Promise((r) => setTimeout(r, 5_000));
    expect(delivered.filter((d) => d.invitationId === event.invitationId)).toHaveLength(1);
  });

  it('a failed attempt is retried and then succeeds', async () => {
    const event = ids();
    failOnce.add(event.invitationId);
    await jobs.emitter.invitationCreated(event);
    await waitFor(
      'retried delivery',
      () => delivered.find((d) => d.invitationId === event.invitationId),
      110_000,
    );
    expect(failOnce.has(event.invitationId)).toBe(false);
    expect(deadLetters.find((d) => d.ids?.invitationId === event.invitationId)).toBeUndefined();
  });

  it('a payload with personal data is dead-lettered without retries and never delivered', async () => {
    const client = createInngestClient(config);
    const bad = { ...ids(), email: 'someone@example.test' };
    await client.send({ name: 'workspace.invitation.created.v1', data: bad });
    const letter = await waitFor('dead letter', () => deadLetters.find((d) => d.ids === null));
    expect(letter.functionId).toBe('invitation-email-v1');
    expect(delivered.find((d) => d.invitationId === bad.invitationId)).toBeUndefined();
  });

  it('an unsigned call to the serve route is refused', async () => {
    const response = await fetch(
      `http://localhost:${PORT}${SERVE_PATH}?fnId=platform-dashboard-invitation-email-v1&stepId=step`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: { name: 'workspace.invitation.created.v1', data: ids() },
          events: [],
          steps: {},
          ctx: {},
        }),
      },
    );
    expect(response.status).toBe(401);
  });
});

describe('S6: notification e-mail through the signed executor', () => {
  it('an outbox emit is delivered once, even when the same outbox row is emitted twice', async () => {
    const event: NotificationEmailRequested = { workspaceId: randomUUID(), notificationId: randomUUID() };
    const outboxId = randomUUID();
    await jobs.emitter.notificationEmailRequested(event, { eventId: outboxId });
    await jobs.emitter.notificationEmailRequested(event, { eventId: outboxId });
    await waitFor('delivery', () => notified.find((n) => n.notificationId === event.notificationId));
    await new Promise((r) => setTimeout(r, 5_000));
    expect(notified.filter((n) => n.notificationId === event.notificationId)).toEqual([event]);
  });
});

describe('S7: host-cache invalidation through the signed executor', () => {
  it('one outbox row emitted twice runs once; a second change of the same project runs again', async () => {
    const event: SiteHostsChanged = { workspaceId: randomUUID(), projectId: randomUUID() };
    const first = randomUUID();
    await jobs.emitter.siteHostsChanged(event, { eventId: first });
    await jobs.emitter.siteHostsChanged(event, { eventId: first });
    await waitFor('invalidation', () => invalidated.find((h) => h.projectId === event.projectId));
    await new Promise((r) => setTimeout(r, 5_000));
    expect(invalidated.filter((h) => h.projectId === event.projectId)).toEqual([event]);
    // No idempotency key on the function: every status change must invalidate again.
    await jobs.emitter.siteHostsChanged(event, { eventId: randomUUID() });
    await waitFor('second invalidation', () =>
      invalidated.filter((h) => h.projectId === event.projectId).length === 2 ? true : undefined,
    );
  });
});
