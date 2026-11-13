/**
 * Every tenant-site path (P1 S7). `/api/health` and `/_next/*` are more specific and win. GET and HEAD only;
 * Next answers 405 for other methods. P2/P3 replace the placeholder document with the rendered SiteVersion.
 */
import { serveHost } from '../../lib/serve';
import { previewSettings } from '../../lib/preview-settings';
import { logger, sitesRuntime } from '../../lib/runtime';
import { emptySiteSource } from '../../lib/site-source';

export const dynamic = 'force-dynamic';

// P3 replaces the empty source with published SiteVersions; until then every live host keeps the placeholder.
const deps = {
  resolver: async () => (await sitesRuntime()).resolver,
  logger,
  source: emptySiteSource,
  // Preview links (FR-TPL-09): configured per environment, off when the host or the secret is missing.
  preview: async () => {
    const settings = previewSettings();
    if (!settings) return null;
    const runtime = await sitesRuntime();
    return {
      ...settings,
      logger,
      catalog: runtime.catalog,
      isRevoked: runtime.isPreviewLinkRevoked,
      sender: runtime.previewLinkSender,
    };
  },
};

export function GET(request: Request): Promise<Response> {
  return serveHost(request, deps);
}

export function HEAD(request: Request): Promise<Response> {
  return serveHost(request, deps);
}
