import { describe, expect, it } from 'vitest';
import {
  KeyValueError,
  createKeyValueStore,
  createMemoryStore,
  createUpstashStore,
  loadKeyValueConfig,
} from './kv';

type Call = { url: string; init: RequestInit };

function upstash(reply: (args: unknown[]) => Response) {
  const calls: Call[] = [];
  const store = createUpstashStore({
    url: 'https://example-cache.upstash.io',
    token: 'tok_test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return reply(JSON.parse(String(init!.body)) as unknown[]);
    },
  });
  return { store, calls };
}

describe('Upstash REST adapter', () => {
  it('sends GET, SET with EX and DEL as JSON commands with the bearer token', async () => {
    const { store, calls } = upstash((args) =>
      Response.json({ result: args[0] === 'GET' ? 'v1' : args[0] === 'DEL' ? 2 : 'OK' }),
    );
    await expect(store.get('k')).resolves.toBe('v1');
    await store.set('k', 'v', 60);
    await expect(store.del(['a', 'b'])).resolves.toBe(2);
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      ['GET', 'k'],
      ['SET', 'k', 'v', 'EX', 60],
      ['DEL', 'a', 'b'],
    ]);
    expect(calls[0]!.url).toBe('https://example-cache.upstash.io/');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok_test');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('a missing key is null; DEL of nothing sends nothing', async () => {
    const { store, calls } = upstash(() => Response.json({ result: null }));
    await expect(store.get('nope')).resolves.toBeNull();
    await expect(store.del([])).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('an HTTP or command error throws KeyValueError without the token, key or value', async () => {
    const { store } = upstash(() => Response.json({ error: 'WRONGPASS invalid password' }, { status: 401 }));
    const error = (await store.get('secret-key').catch((e: unknown) => e)) as KeyValueError;
    expect(error).toBeInstanceOf(KeyValueError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('GET failed (401)');
    expect(error.message).not.toMatch(/tok_test|secret-key/);
    const { store: broken } = upstash(() => new Response('gateway', { status: 502 }));
    await expect(broken.set('k', 'v', 5)).rejects.toThrow(/SET failed \(502\)/);
    const { store: commandError } = upstash(() => Response.json({ error: 'ERR syntax' }));
    await expect(commandError.del(['k'])).rejects.toBeInstanceOf(KeyValueError);
  });

  it('times out instead of holding a request', async () => {
    const store = createUpstashStore({
      url: 'https://example-cache.upstash.io',
      token: 't',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error)),
        ),
    });
    await expect(store.get('k')).rejects.toThrow();
  });

  it('refuses plain http except for a local emulator, and an expiry outside 1 s to 1 day', async () => {
    expect(() => createUpstashStore({ url: 'http://cache.example.test', token: 't' })).toThrow(/https/);
    expect(() => createUpstashStore({ url: '', token: 't' })).toThrow(/required/);
    expect(() => createUpstashStore({ url: 'http://127.0.0.1:8079', token: 't' })).not.toThrow();
    const { store } = upstash(() => Response.json({ result: 'OK' }));
    await expect(store.set('k', 'v', 0)).rejects.toThrow(RangeError);
    await expect(store.set('k', 'v', 86_401)).rejects.toThrow(RangeError);
    await expect(store.set('k', 'v', 1.5)).rejects.toThrow(RangeError);
  });
});

describe('memory store', () => {
  it('expires entries, counts calls and reports TTLs', async () => {
    let now = 1_000;
    const store = createMemoryStore({ now: () => now });
    await store.set('k', 'v', 10);
    expect(await store.get('k')).toBe('v');
    expect(store.ttlOf('k')).toBe(10);
    now += 10_000;
    expect(await store.get('k')).toBeNull();
    await store.set('a', '1', 5);
    expect(await store.del(['a', 'missing'])).toBe(1);
    expect(store.calls).toEqual({ get: 2, set: 2, del: 1 });
    store.clear();
    expect(store.ttlOf('a')).toBeNull();
  });
});

describe('loadKeyValueConfig', () => {
  const both = { UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' };

  it('uses Upstash when both variables are set, and nothing locally when neither is', () => {
    expect(loadKeyValueConfig(both)).toEqual({ kind: 'upstash', url: 'https://x.upstash.io', token: 't' });
    expect(loadKeyValueConfig({})).toEqual({ kind: 'none' });
    expect(createKeyValueStore({ kind: 'none' })).toBeNull();
    expect(createKeyValueStore(loadKeyValueConfig(both))?.name).toBe('upstash');
  });

  it('a deployment needs both; one alone is always a configuration error', () => {
    expect(() => loadKeyValueConfig({ VERCEL_ENV: 'preview' })).toThrow(/must be set when deployed/);
    expect(() =>
      loadKeyValueConfig({ VERCEL_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://x' }),
    ).toThrow();
    expect(() => loadKeyValueConfig({ UPSTASH_REDIS_REST_TOKEN: 't' })).toThrow(/or neither/);
    expect(loadKeyValueConfig({ ...both, VERCEL_ENV: 'production' }).kind).toBe('upstash');
  });
});
