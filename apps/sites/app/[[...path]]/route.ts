/**
 * Every tenant-site path (P1 S7). `/api/health` and `/_next/*` are more specific and win. GET and HEAD only;
 * Next answers 405 for other methods. P2/P3 replace the placeholder document with the rendered SiteVersion.
 */
import { serveHost } from '../../lib/serve';
import { logger, sitesRuntime } from '../../lib/runtime';
import { emptySiteSource } from '../../lib/site-source';

export const dynamic = 'force-dynamic';

// P3 replaces the empty source with published SiteVersions; until then every live host keeps the placeholder.
const deps = { resolver: async () => (await sitesRuntime()).resolver, logger, source: emptySiteSource };

export function GET(request: Request): Promise<Response> {
  return serveHost(request, deps);
}

export function HEAD(request: Request): Promise<Response> {
  return serveHost(request, deps);
}
