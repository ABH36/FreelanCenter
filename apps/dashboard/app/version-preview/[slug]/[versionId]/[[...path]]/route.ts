/**
 * P3 S7b (FR-PUB-03 visual diff): one stored site version, rendered for the side-by-side comparison on the history
 * page. Like the editor preview (lib/preview-response.ts: no script, framed by the dashboard only, noindex), read
 * through the member's own session and RLS: the version id is only a selector, another workspace's version and an
 * unknown id are the same 404.
 *
 * Images come from the version's own snapshot (`site_versions.assets`), never from the asset library, so the preview
 * shows exactly what was published. The snapshot is treated as untrusted: only URLs on the configured asset origin
 * are used (the policy allows no other image origin anyway). Registered with the IDOR harness as
 * `route:/version-preview/[slug]/[versionId]`.
 */
import { isWorkspaceError } from '@platform/workspaces';
import { assetOrigin, previewPath, previewResponse, previewText } from '@/lib/preview-response';
import { publishingService, requireUserId, withRequestContext, workspaces } from '@/lib/workspaces';

type Width = 400 | 800 | 1200 | 1600;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; versionId: string; path?: string[] }> },
) {
  const { slug, versionId, path } = await params;
  const userId = await requireUserId();
  const ws = await (await workspaces()).resolveBySlug(userId, slug);
  if (!ws) return previewText('Not found', 404);
  try {
    const version = await withRequestContext(async () =>
      (await publishingService()).getVersion(userId, ws.id, versionId),
    );
    const origin = assetOrigin();
    const assetUrl = (assetId: string, width: Width) => {
      const url = version.assets[assetId]?.[width];
      return origin && typeof url === 'string' && url.startsWith(`${origin}/`) ? url : null;
    };
    const label = version.kind === 'live' ? 'Live' : 'Staging';
    return previewResponse({
      config: version.config,
      path: previewPath(path),
      origin: new URL(request.url).origin,
      basePath: `/version-preview/${ws.slug}/${version.id}`,
      banner: `Version ${version.number ?? ''} (${label}): a stored copy, not the current site`,
      assetUrl,
    });
  } catch (error) {
    if (isWorkspaceError(error)) {
      return previewText(
        error.code === 'VERSION_UNREADABLE' ? 'This version can no longer be shown.' : 'Not found',
        404,
      );
    }
    throw error;
  }
}
