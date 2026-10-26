import { describe, expect, it } from 'vitest';
import { type KeyValueStore, createMemoryStore } from '@platform/providers';
import {
  HOST_CACHE,
  type HostResolution,
  createHostResolver,
  decodeCached,
  hostCacheKey,
  invalidateHosts,
  normalizeHost,
} from './resolver';

const W = '01920000-0000-7000-8000-000000000001';
const P = '01920000-0000-7000-8000-000000000002';
const site: HostResolution = { outcome: 'placeholder', workspaceId: W, projectId: P };

function setup(
  answers: Record<string, HostResolution> = {},
  cache: KeyValueStore | null = createMemoryStore(),
) {
  const lookups: string[] = [];
  const resolver = createHostResolver({
    cache,
    lookup: async (host) => {
      lookups.push(host);
      return answers[host] ?? { outcome: 'unknown' };
    },
  });
  return { resolver, lookups, cache };
}

describe('normalizeHost', () => {
  it('lower-cases and strips the port and one trailing dot', () => {
    expect(normalizeHost('Sharma-Taxi.Sites.localhost:3001')).toBe('sharma-taxi.sites.localhost');
    expect(normalizeHost(' sharma.example.com. ')).toBe('sharma.example.com');
    expect(normalizeHost('xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com');
  });

  it('refuses anything that is not a plain DNS name', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      '[::1]:3001',
      'user@host.com',
      'a..b.com',
      '-a.com',
      'a-.com',
      'a_b.com',
      'host.com:99999x',
      'host.com:',
      'a.com/path',
      'a.com:80:80',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(127)}com`,
      '%2e.com',
      'é.com',
    ]) {
      expect([bad, normalizeHost(bad)]).toEqual([bad, null]);
    }
  });
});

describe('decodeCached', () => {
  it('accepts only the shapes the resolver writes', () => {
    expect(decodeCached(JSON.stringify({ o: 'unknown' }))).toEqual({ outcome: 'unknown' });
    expect(decodeCached(JSON.stringify({ o: 'maintenance', w: W, p: P }))).toEqual({
      outcome: 'maintenance',
      workspaceId: W,
      projectId: P,
    });
    for (const bad of [
      null,
      'x',
      '{}',
      '[]',
      JSON.stringify({ o: 'placeholder', w: W }),
      JSON.stringify({ o: 'placeholder', w: 'x', p: P }),
      JSON.stringify({ o: 'live', w: W, p: P }),
    ]) {
      expect(decodeCached(bad)).toBeNull();
    }
  });
});

describe('createHostResolver', () => {
  it('miss -> database -> positive cache with the long TTL; then a hit without a lookup', async () => {
    const cache = createMemoryStore();
    const { resolver, lookups } = setup({ 'a.sites.localhost': site }, cache);
    await expect(resolver.resolve('A.sites.localhost:3001')).resolves.toEqual({
      resolution: site,
      source: 'database',
      hostname: 'a.sites.localhost',
    });
    expect(cache.ttlOf(hostCacheKey('a.sites.localhost'))).toBe(HOST_CACHE.positiveTtl);
    await expect(resolver.resolve('a.sites.localhost')).resolves.toMatchObject({
      resolution: site,
      source: 'cache',
    });
    expect(lookups).toEqual(['a.sites.localhost']);
  });

  it('an unknown host is negatively cached with the short TTL', async () => {
    const cache = createMemoryStore();
    const { resolver, lookups } = setup({}, cache);
    expect((await resolver.resolve('nobody.sites.localhost')).resolution).toEqual({ outcome: 'unknown' });
    expect(cache.ttlOf(hostCacheKey('nobody.sites.localhost'))).toBe(HOST_CACHE.negativeTtl);
    expect(await resolver.resolve('nobody.sites.localhost')).toMatchObject({ source: 'cache' });
    expect(lookups).toHaveLength(1);
    expect(HOST_CACHE.negativeTtl).toBeLessThan(HOST_CACHE.positiveTtl);
  });

  it('maintenance answers are cached like sites (per host, positive TTL)', async () => {
    const cache = createMemoryStore();
    const down: HostResolution = { outcome: 'maintenance', workspaceId: W, projectId: P };
    const { resolver } = setup({ 'b.sites.localhost': down }, cache);
    expect((await resolver.resolve('b.sites.localhost')).resolution).toEqual(down);
    expect(cache.ttlOf(hostCacheKey('b.sites.localhost'))).toBe(HOST_CACHE.positiveTtl);
  });

  it('an invalid Host header touches neither the cache nor the database', async () => {
    const cache = createMemoryStore();
    const { resolver, lookups } = setup({}, cache);
    await expect(resolver.resolve('[::1]')).resolves.toEqual({
      resolution: { outcome: 'unknown' },
      source: 'invalid',
      hostname: null,
    });
    expect(lookups).toEqual([]);
    expect(cache.calls).toEqual({ get: 0, set: 0, del: 0 });
  });

  it('expiry: after the TTL the next request looks the host up again', async () => {
    let now = 0;
    const cache = createMemoryStore({ now: () => now });
    const { resolver, lookups } = setup({ 'a.sites.localhost': site }, cache);
    await resolver.resolve('a.sites.localhost');
    now += (HOST_CACHE.positiveTtl - 1) * 1000;
    expect((await resolver.resolve('a.sites.localhost')).source).toBe('cache');
    now += 2000;
    expect((await resolver.resolve('a.sites.localhost')).source).toBe('database');
    expect(lookups).toHaveLength(2);
  });

  it('invalidation removes the cached answer, so the next request sees the new state', async () => {
    const cache = createMemoryStore();
    const answers: Record<string, HostResolution> = { 'a.sites.localhost': site };
    const { resolver } = setup(answers, cache);
    await resolver.resolve('a.sites.localhost');
    answers['a.sites.localhost'] = { outcome: 'maintenance', workspaceId: W, projectId: P };
    expect((await resolver.resolve('a.sites.localhost')).resolution.outcome).toBe('placeholder');
    await expect(
      invalidateHosts(cache, ['A.Sites.Localhost:3001', 'a.sites.localhost', 'junk host']),
    ).resolves.toBe(1);
    expect((await resolver.resolve('a.sites.localhost')).resolution.outcome).toBe('maintenance');
  });

  it('a corrupt cache value is a miss and is overwritten', async () => {
    const cache = createMemoryStore();
    await cache.set(hostCacheKey('a.sites.localhost'), '{"o":"placeholder","w":"not-a-uuid"}', 60);
    const { resolver, lookups } = setup({ 'a.sites.localhost': site }, cache);
    expect(await resolver.resolve('a.sites.localhost')).toMatchObject({
      source: 'database',
      resolution: site,
    });
    expect(decodeCached(await cache.get(hostCacheKey('a.sites.localhost')))).toEqual(site);
    expect(lookups).toHaveLength(1);
  });

  it('a failing cache never fails a request: reads and writes fall through to the database', async () => {
    const broken: KeyValueStore = {
      name: 'broken',
      get: async () => {
        throw new Error('cache down');
      },
      set: async () => {
        throw new Error('cache down');
      },
      del: async () => {
        throw new Error('cache down');
      },
    };
    const warnings: string[] = [];
    const resolver = createHostResolver({
      cache: broken,
      lookup: async () => site,
      logger: { warn: (m: string) => warnings.push(m) } as never,
    });
    expect(await resolver.resolve('a.sites.localhost')).toMatchObject({
      source: 'database',
      resolution: site,
    });
    expect(warnings).toEqual(['sites.host_cache.read_failed', 'sites.host_cache.write_failed']);
    await expect(invalidateHosts(broken, ['a.sites.localhost'])).rejects.toThrow('cache down');
  });

  it('a database error is not cached and reaches the caller', async () => {
    const cache = createMemoryStore();
    let fail = true;
    const resolver = createHostResolver({
      cache,
      lookup: async () => {
        if (fail) throw new Error('db down');
        return site;
      },
    });
    await expect(resolver.resolve('a.sites.localhost')).rejects.toThrow('db down');
    expect(cache.calls.set).toBe(0);
    fail = false;
    expect((await resolver.resolve('a.sites.localhost')).resolution).toEqual(site);
  });

  it('without a cache every request goes to the database', async () => {
    const { resolver, lookups } = setup({ 'a.sites.localhost': site }, null);
    await resolver.resolve('a.sites.localhost');
    await resolver.resolve('a.sites.localhost');
    expect(lookups).toHaveLength(2);
  });

  it('concurrent misses for one host share one lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let lookups = 0;
    const resolver = createHostResolver({
      cache: createMemoryStore(),
      lookup: async () => {
        lookups++;
        await gate;
        return site;
      },
    });
    const all = Promise.all(Array.from({ length: 20 }, () => resolver.resolve('a.sites.localhost')));
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect((await all).every((r) => r.resolution.outcome === 'placeholder')).toBe(true);
    expect(lookups).toBe(1);
  });

  it('keys are per host and namespaced (SRS 5.3 item 7)', () => {
    expect(hostCacheKey('a.sites.localhost')).toBe('sites:host:v1:a.sites.localhost');
  });
});
