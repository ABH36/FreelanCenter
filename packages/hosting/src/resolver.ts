/**
 * Host -> site resolution for apps/sites (SRS 4.3 visitor flow; FR-DOM-07; cross-module contract "public-host
 * resolution"). The answer for one host is cached under its own key (SRS 5.3 item 7: the key is the host, the
 * value names the workspace and project it belongs to), positively and negatively, with a bounded TTL. Changes
 * delete the key (`invalidateHosts`, called by the dashboard's outbox job), so the TTL only bounds staleness when
 * an invalidation is lost.
 *
 * The cache is an optimisation, never a dependency: a cache error falls through to the database. A database
 * error is not cached and reaches the caller, which shows a 503.
 */
import type { Logger } from '@platform/logger';
import type { KeyValueStore } from '@platform/providers';

export type HostResolution =
  { outcome: 'placeholder' | 'maintenance'; workspaceId: string; projectId: string } | { outcome: 'unknown' };

export type HostLookup = (hostname: string) => Promise<HostResolution>;

export interface ResolveResult {
  resolution: HostResolution;
  /** `invalid`: the Host header was not a host name, nothing was looked up. */
  source: 'cache' | 'database' | 'invalid';
  /** The normalised host, or null when invalid. */
  hostname: string | null;
}

export const HOST_CACHE = {
  prefix: 'sites:host:v1:',
  /** Seconds. A lost invalidation is visible for at most this long. */
  positiveTtl: 300,
  /** Seconds. Short: a host allocated after a miss must not stay unknown for long, even without invalidation. */
  negativeTtl: 60,
} as const;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The host name in a `Host` header, lower-cased, without port or trailing dot; null unless it is a plain DNS
 * name (1-253 characters, LDH labels of 1-63). IP literals in brackets, user info and anything else are refused,
 * so junk never reaches the cache or the database.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > 260) return null;
  const colon = host.indexOf(':');
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  return host.split('.').every((label) => LABEL.test(label)) ? host : null;
}

export const hostCacheKey = (hostname: string): string => `${HOST_CACHE.prefix}${hostname}`;

function encode(resolution: HostResolution): string {
  return resolution.outcome === 'unknown'
    ? JSON.stringify({ o: 'unknown' })
    : JSON.stringify({ o: resolution.outcome, w: resolution.workspaceId, p: resolution.projectId });
}

/** A cached value that does not decode is treated as a miss and overwritten. */
export function decodeCached(value: string | null): HostResolution | null {
  if (value === null) return null;
  try {
    const v = JSON.parse(value) as { o?: unknown; w?: unknown; p?: unknown };
    if (v.o === 'unknown') return { outcome: 'unknown' };
    if (
      (v.o === 'placeholder' || v.o === 'maintenance') &&
      typeof v.w === 'string' &&
      typeof v.p === 'string'
    ) {
      if (UUID.test(v.w) && UUID.test(v.p)) return { outcome: v.o, workspaceId: v.w, projectId: v.p };
    }
  } catch {
    // fall through
  }
  return null;
}

export interface HostResolverOptions {
  /** null: no cache configured (local development without Upstash). */
  cache: KeyValueStore | null;
  lookup: HostLookup;
  logger?: Logger;
}

export function createHostResolver(options: HostResolverOptions) {
  const { cache, lookup, logger } = options;
  // Concurrent misses for one host in this instance share one database lookup.
  const inFlight = new Map<string, Promise<HostResolution>>();

  async function fromDatabase(hostname: string): Promise<HostResolution> {
    const resolution = await lookup(hostname);
    if (cache) {
      const ttl = resolution.outcome === 'unknown' ? HOST_CACHE.negativeTtl : HOST_CACHE.positiveTtl;
      await cache
        .set(hostCacheKey(hostname), encode(resolution), ttl)
        .catch((error: unknown) => logger?.warn('sites.host_cache.write_failed', { cause: String(error) }));
    }
    return resolution;
  }

  return {
    async resolve(rawHost: string | null | undefined): Promise<ResolveResult> {
      const hostname = normalizeHost(rawHost);
      if (!hostname) return { resolution: { outcome: 'unknown' }, source: 'invalid', hostname: null };
      if (cache) {
        const cached = await cache.get(hostCacheKey(hostname)).catch((error: unknown) => {
          logger?.warn('sites.host_cache.read_failed', { cause: String(error) });
          return null;
        });
        const decoded = decodeCached(cached);
        if (decoded) return { resolution: decoded, source: 'cache', hostname };
      }
      let pending = inFlight.get(hostname);
      if (!pending) {
        pending = fromDatabase(hostname).finally(() => inFlight.delete(hostname));
        inFlight.set(hostname, pending);
      }
      return { resolution: await pending, source: 'database', hostname };
    },
  };
}

export type HostResolver = ReturnType<typeof createHostResolver>;

/**
 * Deletes the cached answers for these host names (any case, with or without port); returns how many existed.
 * Throws on a cache error so a job can retry it.
 */
export async function invalidateHosts(cache: KeyValueStore, hostnames: readonly string[]): Promise<number> {
  const keys = [...new Set(hostnames.map(normalizeHost).filter((h): h is string => h !== null))].map(
    hostCacheKey,
  );
  return keys.length ? cache.del(keys) : 0;
}
