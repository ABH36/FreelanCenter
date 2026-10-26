/**
 * Key-value cache behind one interface (SRS 4.3: Upstash Redis over REST, edge-compatible; ADR-013: Mumbai).
 * Upstash over its REST API (no SDK: three commands, fewer dependencies to audit). Values are short strings the
 * caller encodes; adapters never log keys, values or the token.
 *
 * SRS 5.3 item 7: callers namespace their keys (`<area>:<kind>:v<n>:<id>`); a store never sees tenant data
 * under a shared key.
 */

export interface KeyValueStore {
  readonly name: string;
  get(key: string): Promise<string | null>;
  /** Always with an expiry: nothing in this cache lives forever. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Returns how many keys existed. */
  del(keys: readonly string[]): Promise<number>;
}

export class KeyValueError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'KeyValueError';
  }
}

export interface UpstashOptions {
  /** `UPSTASH_REDIS_REST_URL`; https unless it points at a local emulator. */
  url: string;
  /** `UPSTASH_REDIS_REST_TOKEN`. */
  token: string;
  fetch?: typeof fetch;
  /** A cache must answer fast or be skipped. Default 1 s. */
  timeoutMs?: number;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checkTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) {
    throw new RangeError('ttlSeconds must be an integer between 1 and 86400');
  }
}

export function createUpstashStore(options: UpstashOptions): KeyValueStore {
  if (!options.url || !options.token) throw new Error('Upstash REST URL and token are required');
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== 'https:' && !LOCAL_HOSTS.has(endpoint.hostname)) {
    throw new Error('the Upstash REST URL must use https');
  }
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1_000;

  async function command(args: Array<string | number>): Promise<unknown> {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) {
      // Upstash error bodies name the command problem; they never echo the token. Keys and values stay out.
      const detail = String(body?.error ?? '').slice(0, 200);
      throw new KeyValueError(
        `upstash ${String(args[0])} failed (${res.status})${detail ? `: ${detail}` : ''}`,
        res.status,
      );
    }
    return body.result;
  }

  return {
    name: 'upstash',
    async get(key) {
      const result = await command(['GET', key]);
      return typeof result === 'string' ? result : null;
    },
    async set(key, value, ttlSeconds) {
      checkTtl(ttlSeconds);
      await command(['SET', key, value, 'EX', ttlSeconds]);
    },
    async del(keys) {
      if (keys.length === 0) return 0;
      const result = await command(['DEL', ...keys]);
      return typeof result === 'number' ? result : 0;
    },
  };
}

/** In-process store for tests (and the counters the tests read). Expiry is honoured on read. */
export interface MemoryKeyValueStore extends KeyValueStore {
  readonly calls: { get: number; set: number; del: number };
  ttlOf(key: string): number | null;
  clear(): void;
}

export function createMemoryStore(options: { now?: () => number } = {}): MemoryKeyValueStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string; expiresAt: number; ttl: number }>();
  const calls = { get: 0, set: 0, del: 0 };
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= now()) entries.delete(key);
    return entries.get(key);
  };
  return {
    name: 'memory',
    calls,
    async get(key) {
      calls.get++;
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      checkTtl(ttlSeconds);
      calls.set++;
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000, ttl: ttlSeconds });
    },
    async del(keys) {
      calls.del++;
      let removed = 0;
      for (const key of keys) if (live(key) && entries.delete(key)) removed++;
      return removed;
    },
    ttlOf(key) {
      return live(key)?.ttl ?? null;
    },
    clear() {
      entries.clear();
    },
  };
}

export type KeyValueConfig = { kind: 'upstash'; url: string; token: string } | { kind: 'none' };

/**
 * `upstash` when both variables are set. A deployment (Vercel preview or production) requires them; locally,
 * neither means no cache (every lookup goes to the database), and only one is a configuration error.
 */
export function loadKeyValueConfig(env: Record<string, string | undefined> = process.env): KeyValueConfig {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const deployed = env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
  if (url && token) return { kind: 'upstash', url, token };
  if (deployed)
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set when deployed');
  if (url || token)
    throw new Error('set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or neither');
  return { kind: 'none' };
}

/** null for `none`: callers then skip caching. */
export function createKeyValueStore(
  config: KeyValueConfig,
  options: { timeoutMs?: number } = {},
): KeyValueStore | null {
  return config.kind === 'upstash' ? createUpstashStore({ ...config, ...options }) : null;
}
