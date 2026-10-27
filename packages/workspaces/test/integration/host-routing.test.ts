/**
 * P1 S7 host routing end to end (FR-DOM-01, FR-DOM-07, FR-WS-04 sites part): the dashboard's commands write a
 * `sites.hosts.changed.v1` outbox row, the invalidation job deletes the cached host resolutions, and the resolver
 * apps/sites uses (cache + `app.resolve_host` as app_public) shows the new state. The cache is the harness's
 * Upstash REST adapter against the stack's emulator (serverless-redis-http), the protocol apps/sites uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from '@platform/db';
import { createPublicDatabase } from '@platform/db/public';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { createHostResolver, hostCacheKey } from '@platform/hosting';
import type { KeyValueStore } from '@platform/providers';
import { createHostCacheInvalidationHandler } from '../../src/host-cache';
import { subdomainLabel } from '../../src/slug';
import {
  audit,
  auth,
  closeAll,
  db,
  hostCache,
  hostCacheHandler,
  projects,
  runJobs,
  unique,
  workspaceWith,
} from '../harness';

const visitor = createPublicDatabase({ connectionString: LOCAL_DATABASE_URLS.public });
const resolver = createHostResolver({ cache: hostCache, lookup: (h) => visitor.resolveHost(h) });
const key = () => crypto.randomUUID();
let adminRole: pg.Pool;
let migrator: pg.Pool;
let platformAdmin: string;

beforeAll(async () => {
  adminRole = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.admin, max: 1 });
  migrator = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.migrator, max: 1 });
  platformAdmin = uuidv7();
  await auth.query(
    `INSERT INTO identity.users (id, name, email, email_verified, two_factor_enabled) VALUES ($1, 'Admin', $2, true, true)`,
    [platformAdmin, `${unique('admin')}@example.test`],
  );
  await migrator.query('SELECT app.operator_grant_platform_admin($1, $2)', [
    platformAdmin,
    'S7 host routing suite',
  ]);
});
afterAll(async () => {
  await Promise.all([visitor.close(), adminRole.end(), migrator.end()]);
  await closeAll();
});

async function hostOf(userId: string, workspaceId: string, projectId: string): Promise<string> {
  const detail = await projects.getProject(userId, workspaceId, projectId);
  return detail.health.subdomain!.hostname;
}

async function step(
  actor: string,
  workspaceId: string,
  projectId: string,
  from: string,
  to: string,
): Promise<void> {
  await projects.transitionProject(actor, { workspaceId, projectId, from, to });
}

const outcome = async (host: string) => (await resolver.resolve(host)).resolution.outcome;

describe('dashboard changes reach apps/sites through the outbox and the host cache', () => {
  it('a host looked up before its project existed is negatively cached; creating the project invalidates it', async () => {
    const ws = await workspaceWith(['editor']);
    await runJobs();
    const name = unique('Host Early');
    const expected = `${subdomainLabel(name)}.sites.localhost`;
    expect(await resolver.resolve(expected)).toMatchObject({
      resolution: { outcome: 'unknown' },
      source: 'database',
    });
    expect(await resolver.resolve(expected)).toMatchObject({ source: 'cache' });

    const { id } = await projects.createProject(ws.members.editor!.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name,
    });
    expect(await hostOf(ws.owner.id, ws.id, id)).toBe(expected);
    // Before the job runs the stale negative answer is still served (bounded by HOST_CACHE.negativeTtl).
    expect(await outcome(expected)).toBe('unknown');
    await runJobs();
    expect(await hostCache.get(hostCacheKey(expected))).toBeNull();
    expect(await resolver.resolve(expected)).toMatchObject({
      resolution: { outcome: 'placeholder', workspaceId: ws.id, projectId: id },
      source: 'database',
    });
  });

  it('every status change invalidates: paused -> maintenance, archived -> unknown, restored -> placeholder', async () => {
    const ws = await workspaceWith(['editor']);
    await runJobs();
    const owner = ws.owner.id;
    const { id } = await projects.createProject(owner, {
      workspaceId: ws.id,
      requestKey: key(),
      name: unique('Host Life'),
    });
    await runJobs();
    const host = await hostOf(owner, ws.id, id);
    for (const [from, to] of [
      ['draft', 'in_review'],
      ['in_review', 'approved'],
      ['approved', 'live'],
    ] as const) {
      await step(owner, ws.id, id, from, to);
      await runJobs();
      expect(await outcome(host)).toBe('placeholder');
    }
    expect((await resolver.resolve(host)).source).toBe('cache');

    await step(owner, ws.id, id, 'live', 'paused');
    expect(await outcome(host)).toBe('placeholder'); // stale until the job runs
    await runJobs();
    expect(await outcome(host)).toBe('maintenance');

    await step(owner, ws.id, id, 'paused', 'archived');
    await runJobs();
    expect(await outcome(host)).toBe('unknown');

    await step(owner, ws.id, id, 'archived', 'draft');
    await runJobs();
    expect(await outcome(host)).toBe('placeholder');
  });

  it('a duplicate gets its own host, which resolves right after the job', async () => {
    const ws = await workspaceWith([]);
    const owner = ws.owner.id;
    const { id } = await projects.createProject(owner, {
      workspaceId: ws.id,
      requestKey: key(),
      name: unique('Host Dup'),
    });
    const copy = await projects.duplicateProject(owner, {
      workspaceId: ws.id,
      projectId: id,
      requestKey: key(),
    });
    await runJobs();
    const host = await hostOf(owner, ws.id, copy.id);
    expect(host).not.toBe(await hostOf(owner, ws.id, id));
    expect((await resolver.resolve(host)).resolution).toEqual({
      outcome: 'placeholder',
      workspaceId: ws.id,
      projectId: copy.id,
    });
  });

  it('the outbox row carries ids only and is dispatched once', async () => {
    const ws = await workspaceWith([]);
    const { id } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: unique('Host Ids'),
    });
    await runJobs();
    const scope = (await db.resolveTenantScope(ws.owner.id, ws.id))!;
    const rows = await db.withTenant(scope, (tx) =>
      tx.outboxEvent.findMany({
        where: { event: 'sites.hosts.changed.v1' },
        select: { payload: true, dispatchedAt: true, attempts: true },
      }),
    );
    expect(rows).toEqual([
      { payload: { workspaceId: ws.id, projectId: id }, dispatchedAt: expect.any(Date), attempts: 1 },
    ]);
  });

  it('a replayed create (same request key) writes no second outbox row', async () => {
    const ws = await workspaceWith([]);
    const requestKey = key();
    const name = unique('Host Replay');
    await projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey, name });
    await projects.createProject(ws.owner.id, { workspaceId: ws.id, requestKey, name });
    await runJobs();
    const scope = (await db.resolveTenantScope(ws.owner.id, ws.id))!;
    expect(
      await db.withTenant(scope, (tx) =>
        tx.outboxEvent.count({ where: { event: 'sites.hosts.changed.v1' } }),
      ),
    ).toBe(1);
  });

  it('suspension (FR-WS-04): after invalidation every host of the workspace shows maintenance; unsuspend restores', async () => {
    const ws = await workspaceWith([]);
    const { id } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: unique('Host Susp'),
    });
    await runJobs();
    const host = await hostOf(ws.owner.id, ws.id, id);
    expect(await outcome(host)).toBe('placeholder');
    const setStatus = (status: string) =>
      adminRole.query('SELECT app.admin_set_workspace_status($1, $2, $3, $4, $5)', [
        platformAdmin,
        ws.id,
        status,
        'S7 suite',
        'corr-s7',
      ]);
    await setStatus('suspended');
    // The admin action (S8) emits the invalidation per project; here the handler is called directly.
    await hostCacheHandler.invalidate({ workspaceId: ws.id, projectId: id });
    expect(await outcome(host)).toBe('maintenance');
    await setStatus('active');
    await hostCacheHandler.invalidate({ workspaceId: ws.id, projectId: id });
    expect(await outcome(host)).toBe('placeholder');
  });

  it("the job reads host names through RLS: another workspace's project id yields nothing", async () => {
    const a = await workspaceWith([]);
    const b = await workspaceWith([]);
    const { id: bProject } = await projects.createProject(b.owner.id, {
      workspaceId: b.id,
      requestKey: key(),
      name: unique('Host B'),
    });
    await runJobs();
    const bHost = await hostOf(b.owner.id, b.id, bProject);
    await resolver.resolve(bHost);
    await expect(hostCacheHandler.invalidate({ workspaceId: a.id, projectId: bProject })).resolves.toEqual({
      hosts: 0,
    });
    expect(await hostCache.get(hostCacheKey(bHost))).not.toBeNull();
  });

  it('a cache built on first use: a configuration error fails the run, not the handler construction', async () => {
    const ws = await workspaceWith([]);
    const { id } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: unique('Host Lazy'),
    });
    await runJobs();
    let built = 0;
    const handler = createHostCacheInvalidationHandler({
      db,
      cache: () => {
        built++;
        throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set when deployed');
      },
    });
    expect(built).toBe(0);
    await expect(handler.invalidate({ workspaceId: ws.id, projectId: id })).rejects.toThrow(/must be set/);
    expect(built).toBe(1);
  });

  it('a failing cache dead-letters the invalidation with ids only, visible to the owner', async () => {
    const ws = await workspaceWith([]);
    const { id } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: key(),
      name: unique('Host Dead'),
    });
    await runJobs();
    const down: KeyValueStore = {
      name: 'down',
      get: async () => null,
      set: async () => undefined,
      del: async () => {
        throw new Error('upstash DEL failed (503)');
      },
    };
    const handler = createHostCacheInvalidationHandler({ db, cache: down });
    await expect(handler.invalidate({ workspaceId: ws.id, projectId: id })).rejects.toThrow('503');
    await handler.deadLetter({
      ids: { workspaceId: ws.id, projectId: id },
      functionId: 'site-host-cache-invalidate-v1',
      runId: 'run-1',
      error: 'upstash DEL failed (503)',
    });
    const letters = await audit.listDeadLetters(ws.owner.id, ws.id);
    expect(letters).toEqual([
      expect.objectContaining({
        functionId: 'site-host-cache-invalidate-v1',
        targetType: 'project',
        targetId: id,
      }),
    ]);
  });
});
