/**
 * Server-only sites runtime (P1 S7): the app_public client and the per-host resolution cache. Built lazily on the
 * first request, so `next build` needs no secrets. Host resolution runs in the route handler, i.e. in the
 * function region (`bom1`, vercel.json; ADR-013), not in a Next proxy: proxy code may run outside the function
 * region and must not rely on shared globals such as a connection pool.
 *
 * ADR-002: nothing here imports dashboard code or auth. The visitor path holds exactly two credentials:
 * DATABASE_URL_PUBLIC (app_public, which can only call the visitor functions: host resolution, catalogue, preview
 * and staging links, and from P3 S8a the client review functions) and the Upstash REST token.
 */
import 'server-only';
import { type PublicDatabase, createPublicDatabase } from '@platform/db/public';
import { type HostResolver, createHostResolver } from '@platform/hosting';
import { createLogger } from '@platform/logger';
import { createKeyValueStore, loadKeyValueConfig } from '@platform/providers';
import { createRateLimiter } from './rate-limit';
import type { RateLimiter } from './review';

export const logger = createLogger({ app: 'sites' });

interface SitesRuntime {
  resolver: HostResolver;
  /** The read-only template catalogue (app.get_catalog_template as app_public). */
  catalog: PublicDatabase['getCatalogTemplate'];
  /** Whether a preview link was revoked in the dashboard (app.is_preview_link_revoked as app_public). */
  isPreviewLinkRevoked: PublicDatabase['isPreviewLinkRevoked'];
  previewLinkSender: PublicDatabase['previewLinkSender'];
  /** P3 S7a: a live version's content (app.get_published_version) and a staging link's site (app.get_staging_site). */
  getPublishedVersion: PublicDatabase['getPublishedVersion'];
  getStagingSite: PublicDatabase['getStagingSite'];
  /** P3 S8a: client review on staging links (comments, approval) and its rate limits. */
  review: Pick<
    PublicDatabase,
    'addReviewComment' | 'approveReviewVersion' | 'getReviewThread' | 'getReviewApproval'
  >;
  limiter: RateLimiter;
  ready: Promise<void>;
}

const globalForSites = globalThis as unknown as { __platformSites?: SitesRuntime };

function build(): SitesRuntime {
  const url = process.env.DATABASE_URL_PUBLIC;
  if (!url) throw new Error('DATABASE_URL_PUBLIC is not set');
  const db = createPublicDatabase({ connectionString: url });
  const store = createKeyValueStore(loadKeyValueConfig());
  const resolver = createHostResolver({
    cache: store,
    lookup: (hostname) => db.resolveHost(hostname),
    logger,
  });
  // One role check per process: the visitor path must never run as a tenant, owner or BYPASSRLS role. A failed
  // check (wrong role, or the database unreachable at start-up) drops this runtime, so the next request retries
  // instead of the instance answering 503 until it is recycled.
  const runtime: SitesRuntime = {
    resolver,
    catalog: (id, version) => db.getCatalogTemplate(id, version),
    isPreviewLinkRevoked: (id) => db.isPreviewLinkRevoked(id),
    previewLinkSender: (id) => db.previewLinkSender(id),
    getPublishedVersion: (id) => db.getPublishedVersion(id),
    getStagingSite: (id) => db.getStagingSite(id),
    review: {
      addReviewComment: (input) => db.addReviewComment(input),
      approveReviewVersion: (input) => db.approveReviewVersion(input),
      getReviewThread: (link, version) => db.getReviewThread(link, version),
      getReviewApproval: (link, version) => db.getReviewApproval(link, version),
    },
    limiter: createRateLimiter(store, logger),
    ready: db.verifyRole(),
  };
  runtime.ready.catch((error: unknown) => {
    logger.fatal('sites.db.role_check_failed', error);
    if (globalForSites.__platformSites === runtime) globalForSites.__platformSites = undefined;
    void db.close().catch(() => undefined);
  });
  return runtime;
}

export async function sitesRuntime(): Promise<SitesRuntime> {
  const runtime = (globalForSites.__platformSites ??= build());
  await runtime.ready;
  return runtime;
}
