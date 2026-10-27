/**
 * P1 S7 cache tests over the Upstash REST protocol (FR-DOM-07; SRS 4.3, 5.3 item 7): the providers adapter against
 * the stack's serverless-redis-http emulator, and the resolver with that cache and the real `app.resolve_host`
 * as app_public. Hit/miss/negative/expiry/invalidation as apps/sites sees them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicDatabase } from '@platform/db/public';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { KeyValueError, createUpstashStore } from '@platform/providers';
import {
  HOST_CACHE,
  type HostResolution,
  createHostResolver,
  hostCacheKey,
  invalidateHosts,
} from '../../src/resolver';
import { LOCAL_UPSTASH } from '../../src/testing';

const store = createUpstashStore({ ...LOCAL_UPSTASH, timeoutMs: 2_000 });
const visitor = createPublicDatabase({ connectionString: LOCAL_DATABASE_URLS.public });
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const host = (label: string) => `${label}-${RUN}.sites.localhost`;
const W = '01920000-0000-7000-8000-000000000001';
const P = '01920000-0000-7000-8000-000000000002';

beforeAll(async () => {
  // The emulator accepts connections slightly before it answers; wait up to 30 s for the first command.
  for (let i = 0; ; i++) {
    try {
      await store.set(`sites:probe:v1:${RUN}`, '1', 5);
      break;
    } catch (error) {
      if (i >= 30) throw error;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
});
afterAll(async () => {
  await visitor.close();
});

describe('Upstash REST adapter against the emulator', () => {
  it('SET with expiry, GET, DEL with a count, and a missing key is null', async () => {
    const key = `sites:test:v1:${RUN}:a`;
    await store.set(key, 'value', 30);
    expect(await store.get(key)).toBe('value');
    expect(await store.del([key, `${key}-missing`])).toBe(1);
    expect(await store.get(key)).toBeNull();
  });

  it('the expiry is real: a 1-second entry is gone after it', async () => {
    const key = `sites:test:v1:${RUN}:ttl`;
    await store.set(key, 'v', 1);
    expect(await store.get(key)).toBe('v');
    await new Promise((r) => setTimeout(r, 2_100));
    expect(await store.get(key)).toBeNull();
  });

  it('a wrong token is refused with a KeyValueError that does not contain the token', async () => {
    const wrong = createUpstashStore({ url: LOCAL_UPSTASH.url, token: 'definitely-wrong-token' });
    const error = (await wrong.get('k').catch((e: unknown) => e)) as KeyValueError;
    expect(error).toBeInstanceOf(KeyValueError);
    expect(error.status).toBeGreaterThanOrEqual(400);
    expect(error.message).not.toContain('definitely-wrong-token');
  });
});

describe('resolver with the Upstash cache', () => {
  it('a real unknown host goes to app.resolve_host once, then is served from the negative cache', async () => {
    let lookups = 0;
    const resolver = createHostResolver({
      cache: store,
      lookup: async (h) => {
        lookups++;
        return visitor.resolveHost(h);
      },
    });
    const h = host('nobody');
    expect(await resolver.resolve(h)).toEqual({
      resolution: { outcome: 'unknown' },
      source: 'database',
      hostname: h,
    });
    expect(await resolver.resolve(h.toUpperCase())).toMatchObject({ source: 'cache' });
    expect(lookups).toBe(1);
    expect(await store.get(hostCacheKey(h))).toBe('{"o":"unknown"}');
  });

  it('miss -> positive entry -> hit; invalidation makes the next request see the new answer', async () => {
    const answers: Record<string, HostResolution> = {};
    const h = host('site');
    answers[h] = { outcome: 'placeholder', workspaceId: W, projectId: P };
    let lookups = 0;
    const resolver = createHostResolver({
      cache: store,
      lookup: async (name) => {
        lookups++;
        return answers[name] ?? { outcome: 'unknown' };
      },
    });
    expect((await resolver.resolve(h)).source).toBe('database');
    expect((await resolver.resolve(h)).source).toBe('cache');
    answers[h] = { outcome: 'maintenance', workspaceId: W, projectId: P };
    expect((await resolver.resolve(h)).resolution.outcome).toBe('placeholder');
    expect(await invalidateHosts(store, [h])).toBe(1);
    expect(await resolver.resolve(h)).toMatchObject({
      resolution: { outcome: 'maintenance' },
      source: 'database',
    });
    expect(lookups).toBe(2);
    expect(HOST_CACHE.positiveTtl).toBe(300);
  });

  it('an unreachable cache does not fail resolution (the database answers)', async () => {
    const down = createUpstashStore({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 300 });
    const resolver = createHostResolver({ cache: down, lookup: (h) => visitor.resolveHost(h) });
    expect(await resolver.resolve(host('down'))).toMatchObject({
      resolution: { outcome: 'unknown' },
      source: 'database',
    });
  });
});
