/**
 * The visitor request (SRS 4.3; FR-DOM-07, FR-WS-04 sites part): Host header -> cached or looked-up resolution
 * -> one of four static documents. Unknown and invalid hosts get 404; a suspended workspace or a paused project
 * gets the maintenance page (503); a database or configuration failure gets 503 and is never cached.
 */
import { getCorrelationIdFromHeaders, runWithContext } from '@platform/logger';
import type { HostResolver } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import { type PageKind, pageResponse } from './pages';

const PAGE_FOR: Record<'placeholder' | 'maintenance' | 'unknown', PageKind> = {
  placeholder: 'placeholder',
  maintenance: 'maintenance',
  unknown: 'not_found',
};

export async function serveHost(
  request: Request,
  deps: { resolver: () => Promise<HostResolver>; logger: Logger },
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
      return pageResponse(PAGE_FOR[resolution.outcome], { head, correlationId });
    } catch (error) {
      deps.logger.error('sites.host.resolve_failed', error);
      return pageResponse('unavailable', { head, correlationId });
    }
  });
}
