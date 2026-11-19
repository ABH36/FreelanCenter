/**
 * The visitor request (SRS 4.3; FR-DOM-07, FR-WS-04 sites part): Host header -> cached or looked-up resolution
 * -> one of four static documents. Unknown and invalid hosts get 404; a suspended workspace or a paused project
 * gets the maintenance page (503); a database or configuration failure gets 503 and is never cached.
 */
import { getCorrelationIdFromHeaders, runWithContext } from '@platform/logger';
import type { HostResolver } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import { buildRobots, buildSitemap, renderDocument } from '@platform/blocks';
import { parseSiteConfig } from '@platform/schema';
import { normalizeHost } from '@platform/hosting';
import { type PageKind, pageResponse } from './pages';
import { type PreviewDeps, servePreview } from './preview';
import { type StagingDeps, serveStaging, serveStagingPost } from './staging';
import { LIVE_CACHE_CONTROL, documentResponse, textResponse } from './site-response';
import type { SiteContent, SiteSource } from './site-source';

const PAGE_FOR: Record<'placeholder' | 'maintenance' | 'unknown', PageKind> = {
  placeholder: 'placeholder',
  maintenance: 'maintenance',
  unknown: 'not_found',
};

const HOST_HEADER = /^[a-z0-9.-]+(:\d{1,5})?$/;

/** A published site: sitemap.xml, robots.txt, or a page of the rendered config (404 page included). */
function serveSite(
  request: Request,
  site: SiteContent,
  hostname: string,
  deps: { logger: Logger },
  common: { head: boolean; correlationId: string | undefined; cacheControl?: string },
): Response {
  const local = hostname.endsWith('localhost');
  const rawHost = request.headers.get('host')?.toLowerCase() ?? '';
  const authority = local && HOST_HEADER.test(rawHost) ? rawHost : hostname;
  const origin = `${local ? 'http' : 'https'}://${authority}`;
  const path = new URL(request.url).pathname;
  const indexable = site.noindex !== true;

  if (path === '/sitemap.xml' || path === '/robots.txt') {
    if (path === '/robots.txt') {
      return textResponse(buildRobots(origin, indexable), 'text/plain; charset=utf-8', {
        ...common,
        indexable: false,
      });
    }
    const parsed = parseSiteConfig(site.config);
    if (!parsed.ok || !indexable) return pageResponse(parsed.ok ? 'not_found' : 'unavailable', common);
    return textResponse(
      buildSitemap(parsed.config, origin, site.lastModified),
      'application/xml; charset=utf-8',
      {
        ...common,
        indexable: false,
      },
    );
  }

  const doc = renderDocument({
    config: site.config,
    path,
    origin,
    mode: 'public',
    ...(site.assetUrl ? { assetUrl: site.assetUrl } : {}),
    ...(site.leadForm !== undefined ? { leadForm: site.leadForm } : {}),
    ...(site.platformBadge !== undefined ? { platformBadge: site.platformBadge } : {}),
    ...(site.noindex ? { noindex: true } : {}),
    onBlockError: (info) => deps.logger.warn('sites.block.error', { ...info }),
  });
  if (doc.kind === 'page') {
    return documentResponse(doc, {
      ...common,
      assetOrigin: site.assetOrigin ?? null,
      leadForm: Boolean(site.leadForm),
      secure: !local,
    });
  }
  // A stored config that no longer validates is a platform fault, not a visitor error: say "unavailable", log paths only.
  deps.logger.warn(
    'sites.render.failed',
    doc.kind === 'invalid'
      ? { kind: doc.kind, paths: doc.issues.slice(0, 10).map((i) => i.path) }
      : { kind: doc.kind },
  );
  return pageResponse('unavailable', common);
}

/** A staging (review) link path: the token entry `/s/<token>` or, since P3 S9b, the clean `/review/<key>`. */
const isStagingPath = (path: string) => path.startsWith('/s/') || path.startsWith('/review/');

const METHOD_NOT_ALLOWED = () =>
  new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });

/**
 * POST (P3 S8a): only the client review forms of a staging link (`/review/<key>/_review/comment|approve` since
 * P3 S9b, and the pre-S9b `/s/<token>/...` form) on the preview host. Every other host and path answers 405.
 */
export async function servePost(
  request: Request,
  deps: {
    logger: Logger;
    preview?: () => Promise<PreviewDeps | null>;
    staging?: () => Promise<StagingDeps | null>;
  },
): Promise<Response> {
  const correlationId = getCorrelationIdFromHeaders(request.headers);
  return runWithContext({ correlationId, app: 'sites' }, async () => {
    try {
      const previewDeps = deps.preview ? await deps.preview() : null;
      const requested = normalizeHost(request.headers.get('host'));
      if (!previewDeps || requested !== previewDeps.host) return METHOD_NOT_ALLOWED();
      if (!isStagingPath(new URL(request.url).pathname)) return METHOD_NOT_ALLOWED();
      const stagingDeps = deps.staging ? await deps.staging() : null;
      if (!stagingDeps) return METHOD_NOT_ALLOWED();
      return await serveStagingPost(request, requested, stagingDeps, { head: false, correlationId });
    } catch (error) {
      deps.logger.error('sites.review.post_failed', error);
      return pageResponse('unavailable', { head: false, correlationId });
    }
  });
}

export async function serveHost(
  request: Request,
  deps: {
    resolver: () => Promise<HostResolver>;
    logger: Logger;
    source?: SiteSource;
    /** Preview links (FR-TPL-09); `null` when not configured, in which case the preview host is just an unknown host. */
    preview?: () => Promise<PreviewDeps | null>;
    /** Staging links (P3 S7a, `/s/<token>` on the preview host); `null` when not configured. */
    staging?: () => Promise<StagingDeps | null>;
  },
): Promise<Response> {
  const correlationId = getCorrelationIdFromHeaders(request.headers);
  const head = request.method === 'HEAD';
  return runWithContext({ correlationId, app: 'sites' }, async () => {
    try {
      const previewDeps = deps.preview ? await deps.preview() : null;
      if (previewDeps) {
        const requested = normalizeHost(request.headers.get('host'));
        if (requested === previewDeps.host) {
          if (isStagingPath(new URL(request.url).pathname)) {
            const stagingDeps = deps.staging ? await deps.staging() : null;
            if (stagingDeps)
              return await serveStaging(request, requested, stagingDeps, { head, correlationId });
          }
          return await servePreview(request, requested, previewDeps, { head, correlationId });
        }
      }
      const resolver = await deps.resolver();
      const { resolution, source, hostname } = await resolver.resolve(request.headers.get('host'));
      if (resolution.outcome !== 'unknown') {
        deps.logger.debug('sites.host.resolved', {
          outcome: resolution.outcome,
          source,
          workspaceId: resolution.workspaceId,
          projectId: resolution.projectId,
        });
      } else if (source === 'invalid') {
        deps.logger.debug('sites.host.invalid');
      } else {
        deps.logger.debug('sites.host.unknown', { hostname, source });
      }
      if (resolution.outcome === 'live') {
        // A version that cannot be read (deleted retention later, or a stale cache entry) keeps the placeholder.
        const site = deps.source && hostname ? await deps.source.load(resolution) : null;
        if (site && hostname) {
          return serveSite(request, site, hostname, deps, {
            head,
            correlationId,
            cacheControl: LIVE_CACHE_CONTROL,
          });
        }
        return pageResponse('placeholder', { head, correlationId });
      }
      return pageResponse(PAGE_FOR[resolution.outcome], { head, correlationId });
    } catch (error) {
      deps.logger.error('sites.host.resolve_failed', error);
      return pageResponse('unavailable', { head, correlationId });
    }
  });
}
