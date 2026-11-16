/**
 * P3 S3 (FR-BLD-02): the editor's live preview. The draft is rendered here, inside the dashboard, by the same renderer
 * the sites app uses (`@platform/blocks`, mode `draft`), and shown in a sandboxed iframe on the editor page. Owner
 * decision 2026-11-15 (option B, replacing Implementation Plan Q10's signed-token preview on the sites host): the draft
 * never leaves the tenant boundary; it is read through the member's own session, membership check and RLS, and no
 * visitor role gains access to drafts.
 *
 * The response and its policy come from lib/preview-response.ts (no script, framed by the dashboard only). Registered
 * with the IDOR harness as `route:/editor-preview/[slug]/[projectId]`.
 */
import { assetIdsIn, isWorkspaceError } from '@platform/workspaces';
import { previewPath, previewResponse, previewText } from '@/lib/preview-response';
import {
  assetService,
  builderService,
  requireUserId,
  withRequestContext,
  workspaces,
} from '@/lib/workspaces';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; projectId: string; path?: string[] }> },
) {
  const { slug, projectId, path } = await params;
  const userId = await requireUserId();
  const ws = await (await workspaces()).resolveBySlug(userId, slug);
  if (!ws) return previewText('Not found', 404);
  try {
    const { draft, images } = await withRequestContext(async () => {
      const found = await (await builderService()).getDraft(userId, ws.id, projectId);
      const ids = [...assetIdsIn(found.config)];
      return {
        draft: found,
        images: await (await assetService()).renderAssets(userId, ws.id, found.projectId, ids),
      };
    });
    return previewResponse({
      config: draft.config,
      path: previewPath(path),
      origin: new URL(request.url).origin,
      // Three segments: the renderer accepts at most three in a base path (built for `/p/<token>`).
      basePath: `/editor-preview/${ws.slug}/${draft.projectId}`,
      banner: 'Draft preview: not published',
      assetUrl: (assetId, width) => images.get(assetId)?.[width] ?? null,
    });
  } catch (error) {
    if (isWorkspaceError(error)) {
      return previewText(error.code === 'NO_DRAFT' ? 'This project has no site yet.' : 'Not found', 404);
    }
    throw error;
  }
}
