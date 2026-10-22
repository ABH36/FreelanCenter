/**
 * Spike G (DG-06): one durable Inngest function against a real Inngest server (`inngest start`, the
 * self-hosted build of the Cloud executor) with event and signing keys enforced.
 * Every scenario is started in beforeAll so the slow backoff paths run in parallel; each test then waits
 * for and checks its own outcome.
 */
import fs from 'node:fs';
import { Inngest } from 'inngest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createClient,
  createNotificationEmailFn,
  NOTIFICATION_EMAIL_EVENT,
  requestNotificationEmail,
  RETRIES,
} from '../src/jobs';
import { EVENT_KEY, INNGEST_BASE_URL, LIVE, SERVE_PATH, SERVE_PORT, SIGNING_KEY } from '../src/keys';
import { createRouteHandler, startServeHandler, type RecordedRequest } from '../src/server';
import { sign, verify } from '../src/signature';
import { World } from '../src/world';
import { sleep, uuid, waitFor } from './helpers';

const results: Record<string, unknown> = {};
const world = new World();
const client = createClient();
const route = createRouteHandler(client, [createNotificationEmailFn(client, world)]);
let srv: Awaited<ReturnType<typeof startServeHandler>>;
let syncResponse: { status: number; body: string };

const seedAndSend = async (scenario: Parameters<World['seed']>[1] = {}, workspaceId = uuid()) => {
  const ids = { workspaceId, notificationId: uuid() };
  world.seed(
    { ...ids, recipient: `${ids.notificationId.slice(0, 8)}@example.test`, template: 'invite' },
    scenario,
  );
  const sentAt = Date.now();
  await requestNotificationEmail(client, ids);
  return { ...ids, sentAt };
};

const S = {} as Record<
  'happy' | 'retry' | 'crash' | 'dupeByKey' | 'dupeByEventId' | 'exhaust' | 'piiBypass',
  { workspaceId: string; notificationId: string; sentAt: number }
>;
const sameWs = uuid();
const serial: { workspaceId: string; notificationId: string }[] = [];
const parallel: { workspaceId: string; notificationId: string }[] = [];

const overlaps = (ids: string[]) => {
  const iv = world.sendIntervals
    .filter((i) => ids.includes(i.notificationId))
    .sort((a, b) => a.start - b.start);
  let n = 0;
  for (let i = 1; i < iv.length; i++) if (iv[i]!.start < iv[i - 1]!.end) n++;
  return { intervals: iv.map((i) => [i.start - iv[0]!.start, i.end - iv[0]!.start]), overlaps: n };
};

beforeAll(async () => {
  srv = await startServeHandler(route, SERVE_PORT);
  const res = await fetch(`http://localhost:${SERVE_PORT}${SERVE_PATH}`, { method: 'PUT' });
  syncResponse = { status: res.status, body: await res.text() };

  S.happy = await seedAndSend();
  S.retry = await seedAndSend({ failTimes: 2 });
  S.crash = await seedAndSend({ crashAfterSendOnce: true });
  S.exhaust = await seedAndSend({ alwaysFail: true });

  // Same notification, two different event ids: only function-level idempotency can dedupe this.
  const dk = { workspaceId: uuid(), notificationId: uuid() };
  world.seed({ ...dk, recipient: 'dupe@example.test', template: 'invite' });
  S.dupeByKey = { ...dk, sentAt: Date.now() };
  await client.send({ id: `a-${uuid()}`, name: NOTIFICATION_EMAIL_EVENT, data: dk });
  await client.send({ id: `b-${uuid()}`, name: NOTIFICATION_EMAIL_EVENT, data: dk });

  // Same event id twice (a retried producer): the helper derives the id from the notification id.
  S.dupeByEventId = await seedAndSend();
  await requestNotificationEmail(client, {
    workspaceId: S.dupeByEventId.workspaceId,
    notificationId: S.dupeByEventId.notificationId,
  });

  // A producer that bypasses the helper and puts PII in the payload.
  const pii = { workspaceId: uuid(), notificationId: uuid() };
  world.seed({ ...pii, recipient: 'pii@example.test', template: 'lead' });
  S.piiBypass = { ...pii, sentAt: Date.now() };
  await client.send({ name: NOTIFICATION_EMAIL_EVENT, data: { ...pii, email: 'pii@example.test' } });

  for (let i = 0; i < 3; i++) serial.push(await seedAndSend({ holdMs: 2500 }, sameWs));
  for (let i = 0; i < 3; i++) parallel.push(await seedAndSend({ holdMs: 2500 }));
}, 60_000);

afterAll(async () => {
  await srv?.close();
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync(
    LIVE ? 'results/spike-g-live-results.json' : 'results/spike-g-results.json',
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        inngestSdk: '4.22.0',
        inngestServer: LIVE ? 'Inngest Cloud' : 'inngest/inngest:v1.46.0',
        results,
      },
      null,
      2,
    ) + '\n',
  );
});

describe('delivery', () => {
  it('G1 the app syncs to the server over the signed cloud-mode path', () => {
    expect(syncResponse.status).toBe(200);
    expect(JSON.parse(syncResponse.body)).toMatchObject({ message: 'Successfully registered' });
    results.sync = syncResponse;
  });

  it('G2 happy path: one run, one email, row marked sent, payload ids only', async () => {
    const runId = await waitFor('happy run', () => world.completedRuns.get(S.happy.notificationId));
    expect(world.delivered.has(S.happy.notificationId)).toBe(true);
    expect(world.rows.get(S.happy.notificationId)!.status).toBe('sent');
    expect(world.loadCalls.get(S.happy.notificationId)).toBe(1);
    const rec = await waitFor('recorded request', () =>
      srv.recorded.find((r) => r.body.includes(S.happy.notificationId)),
    );
    const body = JSON.parse(rec.body);
    expect(Object.keys(body.event.data).sort()).toEqual(['notificationId', 'workspaceId']);
    results.happy = {
      runId,
      latencyMs: world.delivered.get(S.happy.notificationId)!.at - S.happy.sentAt,
      eventDataKeys: Object.keys(body.event.data).sort(),
    };
  });

  it('G3 transient provider failure is retried after a backoff delay; completed steps are not re-run', async () => {
    await waitFor('retry run', () => world.completedRuns.get(S.retry.notificationId), 150_000);
    const attempts = world.sendAttempts.get(S.retry.notificationId)!;
    expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
    const gaps = attempts.slice(1).map((a, i) => a.at - attempts[i]!.at);
    // The server adds jitter, so successive gaps are not strictly ordered; every retry is delayed, though.
    for (const g of gaps) expect(g).toBeGreaterThan(10_000);
    expect(world.loadCalls.get(S.retry.notificationId)).toBe(1); // memoized step
    expect(world.delivered.has(S.retry.notificationId)).toBe(true);
    results.retry = { attempts: attempts.length, backoffGapsMs: gaps, loadCalls: 1 };
  }, 160_000);

  it('G4 a step that crashes after the provider accepted is re-run; the provider key prevents a second email', async () => {
    await waitFor('crash run', () => world.completedRuns.get(S.crash.notificationId), 90_000);
    expect(world.sendAttempts.get(S.crash.notificationId)).toHaveLength(2);
    expect(world.duplicateSendsSuppressed.get(S.crash.notificationId)).toBe(1);
    expect([...world.delivered.keys()].filter((k) => k === S.crash.notificationId)).toHaveLength(1);
    results.crashAfterSend = { providerCalls: 2, emailsDelivered: 1, duplicateSuppressedByProviderKey: 1 };
  }, 100_000);
});

describe('idempotency', () => {
  it('G5 two events with different ids for one notification produce one run (function idempotency key)', async () => {
    await waitFor('dupe run', () => world.completedRuns.get(S.dupeByKey.notificationId));
    await sleep(8_000);
    expect(world.loadCalls.get(S.dupeByKey.notificationId)).toBe(1);
    expect(world.sendAttempts.get(S.dupeByKey.notificationId)).toHaveLength(1);
    results.idempotencyKey = { eventsSent: 2, runs: 1 };
  }, 120_000);

  it('G6 the same event id sent twice produces one run (event-id de-duplication)', async () => {
    await waitFor('event-id run', () => world.completedRuns.get(S.dupeByEventId.notificationId));
    await sleep(5_000);
    expect(world.loadCalls.get(S.dupeByEventId.notificationId)).toBe(1);
    results.eventIdDedupe = { sends: 2, runs: 1 };
  }, 120_000);
});

describe('payload privacy', () => {
  it('G7 the sender helper refuses anything but {workspaceId, notificationId}', async () => {
    const bad = { workspaceId: uuid(), notificationId: uuid(), email: 'x@example.test' } as never;
    await expect(requestNotificationEmail(client, bad)).rejects.toThrow(
      /exactly \{workspaceId, notificationId\}/,
    );
    await expect(
      requestNotificationEmail(client, { workspaceId: 'ws-1', notificationId: uuid() }),
    ).rejects.toThrow(/UUID/);
  });

  it('G8 a PII payload that bypasses the helper fails without retries and is dead-lettered', async () => {
    const dl = await waitFor('pii dead letter', () =>
      world.deadLetters.find((d) => d.notificationId === S.piiBypass.notificationId),
    );
    expect(dl.error).toMatch(/exactly \{workspaceId, notificationId\}/);
    expect(world.loadCalls.get(S.piiBypass.notificationId)).toBeUndefined();
    expect(world.sendAttempts.get(S.piiBypass.notificationId)).toBeUndefined();
    results.piiBypass = { deadLetteredAfterMs: Date.parse(dl.at) - S.piiBypass.sentAt, retries: 0 };
  });
});

describe('concurrency', () => {
  it('G9 runs of one workspace never overlap; different workspaces run in parallel', async () => {
    const all = [...serial, ...parallel];
    await waitFor(
      'concurrency runs',
      () => all.every((n) => world.completedRuns.has(n.notificationId)),
      120_000,
    );
    const same = overlaps(serial.map((n) => n.notificationId));
    const cross = overlaps(parallel.map((n) => n.notificationId));
    expect(world.maxInflightByWorkspace.get(sameWs)).toBe(1);
    expect(same.overlaps).toBe(0);
    expect(cross.overlaps).toBeGreaterThan(0);
    results.concurrency = { sameWorkspace: same, differentWorkspaces: cross };
  }, 130_000);
});

describe('signed requests (SEC-06)', () => {
  const posts = () => srv.recorded.filter((r) => r.method === 'POST');
  const post = (body: string, signature?: string) =>
    route.POST(
      new Request(
        `http://localhost:${SERVE_PORT}${SERVE_PATH}?fnId=spike-g-notification-email-v1&stepId=step`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(signature ? { 'x-inngest-signature': signature } : {}),
          },
          body,
        },
      ),
    );
  const happyRequest = (): RecordedRequest =>
    posts().find((r) => r.body.includes(S.happy.notificationId) && r.status < 300)!;

  it('G11 every executor request and every SDK response carries a signature that verifies independently', async () => {
    await waitFor('happy run', () => world.completedRuns.get(S.happy.notificationId));
    const all = posts();
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) {
      expect(verify(r.signature!, JSON.parse(r.body), SIGNING_KEY)).toMatchObject({ ok: true });
      expect(verify(r.responseSignature!, r.responseBody, SIGNING_KEY)).toMatchObject({ ok: true });
    }
    results.signedRequests = { executorRequestsVerified: all.length, sdkResponsesVerified: all.length };
  });

  it('G12 missing, wrong-key, tampered, expired and future signatures are rejected with no side effect', async () => {
    const r = happyRequest();
    const body = JSON.parse(r.body);
    const now = Math.floor(Date.now() / 1000);
    const loadsBefore = world.loadCalls.get(S.happy.notificationId);
    const tampered = JSON.stringify({
      ...body,
      event: { ...body.event, data: { ...body.event.data, workspaceId: uuid() } },
    });
    const cases = {
      missing: await post(r.body),
      wrongKey: await post(r.body, sign(body, `signkey-prod-${'ab'.repeat(32)}`, now)),
      tamperedBody: await post(tampered, r.signature!),
      expired6min: await post(r.body, sign(body, SIGNING_KEY, now - 360)),
      future6min: await post(r.body, sign(body, SIGNING_KEY, now + 360)),
      garbage: await post(r.body, 'not-a-signature'),
    };
    const statuses = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.status]));
    for (const s of Object.values(statuses)) expect(s).toBe(401);
    expect(world.loadCalls.get(S.happy.notificationId)).toBe(loadsBefore);
    results.signatureRejections = statuses;
  });

  it('G13 a freshly signed request from the independent signer is accepted; a captured request replays inside 5 min', async () => {
    const r = happyRequest();
    const body = JSON.parse(r.body);
    const loadsBefore = world.loadCalls.get(S.happy.notificationId)!;
    const fresh = await post(r.body, sign(body, SIGNING_KEY, Math.floor(Date.now() / 1000)));
    expect(fresh.status).toBeLessThan(300);
    const replay = await post(r.body, r.signature!);
    expect(replay.status).toBeLessThan(300);
    // Both re-executed the function; only the provider idempotency key kept the email count at one.
    expect(world.loadCalls.get(S.happy.notificationId)).toBeGreaterThan(loadsBefore);
    expect([...world.delivered.keys()].filter((k) => k === S.happy.notificationId)).toHaveLength(1);
    results.replay = {
      independentlySignedStatus: fresh.status,
      capturedReplayStatus: replay.status,
      replayAgeSeconds: (verify(r.signature!, body, SIGNING_KEY) as { ageSeconds?: number }).ageSeconds,
      functionReExecuted: true,
      emailsDelivered: 1,
    };
  });

  it('G14 dev mode disables signature checks; INNGEST_DEV turns it on unless isDev is set explicitly', async () => {
    const devWorld = new World();
    const devClient = createClient({ isDev: true });
    const devRoute = createRouteHandler(devClient, [createNotificationEmailFn(devClient, devWorld)]);
    const ids = { workspaceId: uuid(), notificationId: uuid() };
    devWorld.seed({ ...ids, recipient: 'dev@example.test', template: 'invite' });
    const forged = JSON.parse(happyRequest().body);
    forged.event.data = ids;
    forged.events = [forged.event];
    const res = await devRoute.POST(
      new Request(
        `http://localhost:${SERVE_PORT}${SERVE_PATH}?fnId=spike-g-notification-email-v1&stepId=step`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(forged),
        },
      ),
    );
    expect(res.status).toBeLessThan(300);
    expect(devWorld.loadCalls.get(ids.notificationId)).toBe(1);

    const saved = process.env.INNGEST_DEV;
    process.env.INNGEST_DEV = '1';
    try {
      const implicit = new Inngest({ id: 'x', signingKey: SIGNING_KEY, eventKey: EVENT_KEY });
      const explicit = new Inngest({ id: 'x', signingKey: SIGNING_KEY, eventKey: EVENT_KEY, isDev: false });
      expect(implicit.mode).toBe('dev');
      expect(explicit.mode).toBe('cloud');
      results.devModeHazard = {
        unsignedForgedRequestInDevMode: res.status,
        modeWithEnvOnly: implicit.mode,
        modeWithExplicitIsDevFalse: explicit.mode,
      };
    } finally {
      if (saved === undefined) delete process.env.INNGEST_DEV;
      else process.env.INNGEST_DEV = saved;
    }
  });

  it('G15 the server refuses events sent with a wrong event key', async () => {
    const wrong = new Inngest({
      id: 'spike-g',
      isDev: false,
      baseUrl: INNGEST_BASE_URL,
      eventKey: 'wrong-key',
    });
    const err = await wrong
      .send({ name: NOTIFICATION_EMAIL_EVENT, data: { workspaceId: uuid(), notificationId: uuid() } })
      .then(
        () => null,
        (e: Error) => e.message,
      );
    expect(err).not.toBeNull();
    results.wrongEventKey = err;
  });

  it('G16 unauthenticated GET introspection reveals no function configuration', async () => {
    const res = await route.GET(new Request(`http://localhost:${SERVE_PORT}${SERVE_PATH}`));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('signing_key_hash');
    expect(JSON.stringify(body)).not.toContain('notification-email-v1');
    results.introspectionUnsigned = body;
  });
});

describe('dead letter', () => {
  it('G10 a permanently failing run makes 1 + RETRIES attempts, then the failure handler dead-letters it', async () => {
    const dl = await waitFor(
      'exhausted dead letter',
      () => world.deadLetters.find((d) => d.notificationId === S.exhaust.notificationId),
      280_000,
    );
    const attempts = world.sendAttempts.get(S.exhaust.notificationId)!;
    expect(attempts).toHaveLength(RETRIES + 1);
    for (const [i, a] of attempts.slice(1).entries()) expect(a.at - attempts[i]!.at).toBeGreaterThan(10_000);
    expect(dl).toMatchObject({
      workspaceId: S.exhaust.workspaceId,
      functionId: expect.stringContaining('notification-email-v1'),
    });
    expect(dl.error).toMatch(/simulated 503/);
    expect(Object.keys(dl).sort()).toEqual([
      'at',
      'error',
      'functionId',
      'notificationId',
      'runId',
      'workspaceId',
    ]);
    expect(world.alerts.some((a) => a.includes(dl.runId))).toBe(true);
    expect(world.rows.get(S.exhaust.notificationId)!.status).toBe('pending');
    results.deadLetter = {
      attempts: attempts.length,
      backoffGapsMs: attempts.slice(1).map((a, i) => a.at - attempts[i]!.at),
      deadLetteredAfterMs: Date.parse(dl.at) - S.exhaust.sentAt,
      record: { ...dl, runId: '<run id>' },
    };
  }, 300_000);
});
