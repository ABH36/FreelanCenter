import { describe, expect, it, vi } from 'vitest';
import {
  EVENTS,
  INVITATION_EMAIL_FUNCTION,
  InvalidPayloadError,
  JobsConfigError,
  PACKAGE_NAME,
  createInlineJobs,
  createInngestClient,
  createInvitationEmailFunction,
  createHostCacheInvalidationFunction,
  createNotificationEmailFunction,
  createOutboxSweepFunction,
  HOST_CACHE_INVALIDATION_FUNCTION,
  NOTIFICATION_EMAIL_FUNCTION,
  OUTBOX_SWEEP_FUNCTION,
  loadJobsConfig,
  parseInvitationCreated,
  parseSiteHostsChanged,
  type InvitationEmailHandler,
} from './index';

const IDS = {
  workspaceId: '01900000-0000-7000-8000-000000000001',
  invitationId: '01900000-0000-7000-8000-000000000002',
};
const KEYS = { INNGEST_SIGNING_KEY: 'signkey-test-00', INNGEST_EVENT_KEY: 'event-key' };

describe('@platform/jobs', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@platform/jobs');
  });
});

describe('loadJobsConfig (ADR-007 rule 1, Spike G G-1)', () => {
  it('local default is the inline transport; deployments default to Inngest', () => {
    expect(loadJobsConfig({})).toEqual({ transport: 'inline', isDev: false });
    expect(loadJobsConfig({ VERCEL_ENV: 'preview', ...KEYS })).toMatchObject({
      transport: 'inngest',
      isDev: false,
    });
  });

  it.each(['preview', 'production'])(
    '%s refuses dev mode, inline, a custom base URL and missing keys',
    (env) => {
      const base = { VERCEL_ENV: env, ...KEYS };
      expect(() => loadJobsConfig({ ...base, INNGEST_DEV: '1' })).toThrow(JobsConfigError);
      expect(() => loadJobsConfig({ ...base, JOBS_TRANSPORT: 'inline' })).toThrow(JobsConfigError);
      expect(() => loadJobsConfig({ ...base, INNGEST_BASE_URL: 'http://localhost:8288' })).toThrow(
        JobsConfigError,
      );
      expect(() => loadJobsConfig({ VERCEL_ENV: env, INNGEST_EVENT_KEY: 'k' })).toThrow(/SIGNING_KEY/);
      expect(() => loadJobsConfig({ VERCEL_ENV: env, INNGEST_SIGNING_KEY: 'k' })).toThrow(/EVENT_KEY/);
    },
  );

  it('isDev is explicit: only a local INNGEST_DEV turns it on, and then keys are optional', () => {
    expect(loadJobsConfig({ JOBS_TRANSPORT: 'inngest', INNGEST_DEV: '1' })).toMatchObject({ isDev: true });
    expect(loadJobsConfig({ JOBS_TRANSPORT: 'inngest', INNGEST_DEV: '0', ...KEYS })).toMatchObject({
      isDev: false,
    });
    expect(() => loadJobsConfig({ JOBS_TRANSPORT: 'inngest' })).toThrow(/SIGNING_KEY/);
    expect(() => loadJobsConfig({ JOBS_TRANSPORT: 'queue' })).toThrow(/JOBS_TRANSPORT/);
  });
});

describe('ids-only payloads (ADR-007 rule 3)', () => {
  it('accepts exactly the ids', () => {
    expect(parseInvitationCreated({ ...IDS })).toEqual(IDS);
  });

  it.each([
    ['an extra field (PII)', { ...IDS, email: 'someone@example.test' }],
    ['a missing id', { workspaceId: IDS.workspaceId }],
    ['a non-UUID', { ...IDS, invitationId: 'abc' }],
    ['an array', [IDS]],
    ['null', null],
  ])('rejects %s', (_label, data) => {
    expect(() => parseInvitationCreated(data)).toThrow(InvalidPayloadError);
  });
});

describe('invitation e-mail function definition', () => {
  it('retries, is idempotent per invitation and limits concurrency per workspace', () => {
    const client = createInngestClient({ transport: 'inngest', isDev: true });
    const fn = createInvitationEmailFunction(client, { deliver: vi.fn(), deadLetter: vi.fn() });
    expect(fn.opts).toMatchObject({
      id: INVITATION_EMAIL_FUNCTION.id,
      triggers: [{ event: EVENTS.invitationCreated }],
      retries: 3,
      idempotency: 'event.data.invitationId',
      concurrency: [{ key: 'event.data.workspaceId', limit: 2 }],
    });
    expect(typeof fn.opts.onFailure).toBe('function');
  });
});

describe('inline transport (local development and tests)', () => {
  function handler(deliver: InvitationEmailHandler['deliver']) {
    return { deliver: vi.fn(deliver), deadLetter: vi.fn(async () => {}) };
  }

  it('runs the handler after the response, with validated ids', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const h = handler(async () => 'sent');
    const jobs = createInlineJobs({ invitationEmail: h }, (task) => void tasks.push(task));
    await jobs.emitter.invitationCreated(IDS);
    expect(h.deliver).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(h.deliver).toHaveBeenCalledWith(IDS);
    expect(jobs.route).toBeNull();
  });

  it('a failed delivery goes to the dead-letter hook', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const h = handler(async () => {
      throw new Error('provider down');
    });
    const jobs = createInlineJobs({ invitationEmail: h }, (task) => void tasks.push(task));
    await jobs.emitter.invitationCreated(IDS);
    await tasks[0]!();
    expect(h.deadLetter).toHaveBeenCalledWith({
      ids: IDS,
      functionId: INVITATION_EMAIL_FUNCTION.id,
      runId: 'inline',
      error: 'provider down',
    });
  });

  it('refuses a payload with anything but ids before scheduling work', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const jobs = createInlineJobs(
      { invitationEmail: handler(async () => 'sent') },
      (t) => void tasks.push(t),
    );
    await expect(
      jobs.emitter.invitationCreated({ ...IDS, email: 'x@example.test' } as unknown as typeof IDS),
    ).rejects.toThrow(InvalidPayloadError);
    expect(tasks).toHaveLength(0);
  });
});

describe('S6: notification e-mail and outbox sweep', () => {
  const N = { workspaceId: IDS.workspaceId, notificationId: '01900000-0000-7000-8000-000000000003' };

  it('the notification function retries, is idempotent per notification and limits concurrency per workspace', () => {
    const client = createInngestClient({ transport: 'inngest', isDev: true });
    const fn = createNotificationEmailFunction(client, { deliver: vi.fn(), deadLetter: vi.fn() });
    expect(fn.opts).toMatchObject({
      id: NOTIFICATION_EMAIL_FUNCTION.id,
      triggers: [{ event: EVENTS.notificationEmailRequested }],
      retries: 3,
      idempotency: 'event.data.notificationId',
      concurrency: [{ key: 'event.data.workspaceId', limit: 5 }],
    });
    expect(typeof fn.opts.onFailure).toBe('function');
  });

  it('the sweep is a cron function that never overlaps itself', () => {
    const client = createInngestClient({ transport: 'inngest', isDev: true });
    const fn = createOutboxSweepFunction(client, { sweep: vi.fn() });
    expect(fn.opts).toMatchObject({
      id: OUTBOX_SWEEP_FUNCTION.id,
      triggers: [{ cron: '*/5 * * * *' }],
      concurrency: [{ limit: 1 }],
    });
  });

  it('inline: delivers after the response, dead-letters a failure, refuses non-id payloads', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const notificationEmail = {
      deliver: vi.fn(async () => {
        throw new Error('provider down');
      }),
      deadLetter: vi.fn(async () => {}),
    };
    const jobs = createInlineJobs(
      { invitationEmail: { deliver: vi.fn(), deadLetter: vi.fn() }, notificationEmail },
      (t) => void tasks.push(t),
    );
    await jobs.emitter.notificationEmailRequested(N, { eventId: 'x' });
    await tasks[0]!();
    expect(notificationEmail.deliver).toHaveBeenCalledWith(N);
    expect(notificationEmail.deadLetter).toHaveBeenCalledWith({
      ids: N,
      functionId: NOTIFICATION_EMAIL_FUNCTION.id,
      runId: 'inline',
      error: 'provider down',
    });
    await expect(
      jobs.emitter.notificationEmailRequested({ ...N, to: 'x@example.test' } as unknown as typeof N, {
        eventId: 'y',
      }),
    ).rejects.toThrow(InvalidPayloadError);
    expect(tasks).toHaveLength(1);
  });
});

describe('S7: host-cache invalidation', () => {
  const H = { workspaceId: IDS.workspaceId, projectId: '01900000-0000-7000-8000-000000000004' };

  it('retries, has no idempotency key (every change must invalidate) and limits concurrency per workspace', () => {
    const client = createInngestClient({ transport: 'inngest', isDev: true });
    const fn = createHostCacheInvalidationFunction(client, { invalidate: vi.fn(), deadLetter: vi.fn() });
    expect(fn.opts).toMatchObject({
      id: HOST_CACHE_INVALIDATION_FUNCTION.id,
      name: 'sites.host_cache.invalidate.v1',
      triggers: [{ event: EVENTS.siteHostsChanged }],
      retries: 5,
      concurrency: [{ key: 'event.data.workspaceId', limit: 5 }],
    });
    expect(fn.opts).not.toHaveProperty('idempotency');
    expect(typeof fn.opts.onFailure).toBe('function');
    expect(EVENTS.siteHostsChanged).toBe('sites.hosts.changed.v1');
  });

  it('payload: exactly workspaceId and projectId', () => {
    expect(parseSiteHostsChanged({ ...H })).toEqual(H);
    expect(() => parseSiteHostsChanged({ ...H, hostname: 'a.example.test' })).toThrow(InvalidPayloadError);
    expect(() => parseSiteHostsChanged({ workspaceId: H.workspaceId })).toThrow(InvalidPayloadError);
  });

  it('inline: invalidates after the response and dead-letters a failure', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const hostCacheInvalidation = {
      invalidate: vi.fn(async () => {
        throw new Error('cache down');
      }),
      deadLetter: vi.fn(async () => {}),
    };
    const jobs = createInlineJobs(
      { invitationEmail: { deliver: vi.fn(), deadLetter: vi.fn() }, hostCacheInvalidation },
      (t) => void tasks.push(t),
    );
    await jobs.emitter.siteHostsChanged(H, { eventId: 'x' });
    expect(hostCacheInvalidation.invalidate).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(hostCacheInvalidation.invalidate).toHaveBeenCalledWith(H);
    expect(hostCacheInvalidation.deadLetter).toHaveBeenCalledWith({
      ids: H,
      functionId: HOST_CACHE_INVALIDATION_FUNCTION.id,
      runId: 'inline',
      error: 'cache down',
    });
    const without = createInlineJobs(
      { invitationEmail: { deliver: vi.fn(), deadLetter: vi.fn() } },
      (t) => void tasks.push(t),
    );
    await expect(without.emitter.siteHostsChanged(H, { eventId: 'y' })).rejects.toThrow(/no host-cache/);
  });
});
