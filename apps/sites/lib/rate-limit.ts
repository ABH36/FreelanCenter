/**
 * Fixed-window rate limits for the client review forms (P3 S8a). Counters live in Upstash (shared by every
 * instance) under `sites:review:v1:<key>`; without a configured store (local development) they live in the
 * process. A store failure lets the request through and logs it: the database still caps comments per version
 * (300), and refusing every client because the cache is down would be worse.
 */
import type { Logger } from '@platform/logger';
import { type KeyValueStore, createMemoryStore } from '@platform/providers';
import type { RateLimiter } from './review';

const PREFIX = 'sites:review:v1:';

export function createRateLimiter(store: KeyValueStore | null, logger: Logger): RateLimiter {
  const counters = store ?? createMemoryStore();
  return {
    async allow(key, limit, windowSeconds) {
      try {
        return (await counters.incr(`${PREFIX}${key}`, windowSeconds)) <= limit;
      } catch (error) {
        logger.warn('sites.review.rate_limit_unavailable', { error: (error as Error).name });
        return true;
      }
    },
  };
}
