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
import { type PageKind, pageResponse } from './pages';
import { documentResponse, textResponse } from './site-response';
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
  common: { head: boolean; correlationId: string | undefined },
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

export async function serveHost(
  request: Request,
  deps: { resolver: () => Promise<HostResolver>; logger: Logger; source?: SiteSource },
): Promise<Response> {
  const correlationId = getCorrelationIdFromHeaders(request.headers);
  const head = request.method === 'HEAD';
  return runWithContext({ correlationId, app: 'sites' }, async () => {
    try {
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
      if (resolution.outcome === 'placeholder' && deps.source && hostname) {
        const site = await deps.source.load(resolution);
        if (site) return serveSite(request, site, hostname, deps, { head, correlationId });
      }
      return pageResponse(PAGE_FOR[resolution.outcome], { head, correlationId });
    } catch (error) {
      deps.logger.error('sites.host.resolve_failed', error);
      return pageResponse('unavailable', { head, correlationId });
    }
  });
}
