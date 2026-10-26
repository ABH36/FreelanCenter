/**
 * @platform/hosting - host routing for tenant sites (module 12; P1 S7). Shared by apps/sites (resolution) and
 * the dashboard's background jobs (invalidation), so both agree on the cache keys. No database, auth or
 * dashboard code: the caller passes the lookup (apps/sites: `@platform/db/public`).
 */
export const PACKAGE_NAME = '@platform/hosting' as const;

export {
  HOST_CACHE,
  type HostLookup,
  type HostResolution,
  type HostResolver,
  type HostResolverOptions,
  type ResolveResult,
  createHostResolver,
  decodeCached,
  hostCacheKey,
  invalidateHosts,
  normalizeHost,
} from './resolver';
