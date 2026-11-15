/**
 * Every tenant-site path (P1 S7). `/api/health` and `/_next/*` are more specific and win. GET and HEAD only;
 * Next answers 405 for other methods. A host with a live version renders it (P3 S7a); the preview host also serves
 * staging links (`/s/<token>`).
 */
import { serveHost } from '../../lib/serve';
import { previewSettings } from '../../lib/preview-settings';
import { logger, sitesRuntime } from '../../lib/runtime';
import { createVersionSiteSource } from '../../lib/site-source';

export const dynamic = 'force-dynamic';

const deps = {
  resolver: async () => (await sitesRuntime()).resolver,
  logger,
  source: createVersionSiteSource(async (id) => (await sitesRuntime()).getPublishedVersion(id)),
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
  // Staging links share the preview host and secret (domain-separated tokens).
  staging: async () => {
    const settings = previewSettings();
    if (!settings) return null;
    const runtime = await sitesRuntime();
    return { secrets: settings.secrets, logger, stagingSite: runtime.getStagingSite };
  },
};

export function GET(request: Request): Promise<Response> {
  return serveHost(request, deps);
}

export function HEAD(request: Request): Promise<Response> {
  return serveHost(request, deps);
}
