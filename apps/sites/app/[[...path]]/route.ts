/**
 * Every tenant-site path (P1 S7). `/api/health` and `/_next/*` are more specific and win. A host with a live version
 * renders it (P3 S7a); the preview host also serves preview links (`/p/<token>` → `/preview/<key>`) and staging links
 * (`/s/<token>` → `/review/<key>`, P3 S9b: the token moves into a path-scoped cookie). POST exists only for the
 * client review forms of a staging link (P3 S8a, `/review/<key>/_review/comment|approve`, and the pre-S9b
 * `/s/<token>/...` form); every other POST is 405.
 */
import { serveHost, servePost } from '../../lib/serve';
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
  // Staging links share the preview host and secret (domain-separated tokens), and carry the client review.
  staging: async () => {
    const settings = previewSettings();
    if (!settings) return null;
    const runtime = await sitesRuntime();
    return {
      secrets: settings.secrets,
      logger,
      stagingSite: runtime.getStagingSite,
      review: {
        addComment: runtime.review.addReviewComment,
        approve: runtime.review.approveReviewVersion,
        thread: runtime.review.getReviewThread,
        approval: runtime.review.getReviewApproval,
        limiter: runtime.limiter,
        ipKey: settings.secrets.current,
        logger,
      },
    };
  },
};

export function GET(request: Request): Promise<Response> {
  return serveHost(request, deps);
}

export function HEAD(request: Request): Promise<Response> {
  return serveHost(request, deps);
}

export function POST(request: Request): Promise<Response> {
  return servePost(request, deps);
}
