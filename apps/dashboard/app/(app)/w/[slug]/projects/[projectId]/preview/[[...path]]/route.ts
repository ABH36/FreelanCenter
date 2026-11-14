/**
 * P3 S3 (FR-BLD-02): the editor's live preview. The draft is rendered here, inside the dashboard, by the same renderer
 * the sites app uses (`@platform/blocks`, mode `draft`), and shown in a sandboxed iframe on the editor page. Owner
 * decision 2026-11-15 (option B, replacing Implementation Plan Q10's signed-token preview on the sites host): the draft
 * never leaves the tenant boundary; it is read through the member's own session, membership check and RLS, and no
 * visitor role gains access to drafts.
 *
 * The response runs no script: the renderer emits none and the policy allows none. It may be framed by the dashboard
 * only (`frame-ancestors 'self'`); every other dashboard page keeps `frame-ancestors 'none'` (next.config.ts excludes
 * only this path from the global header). Registered with the IDOR harness as
 * `route:/w/[slug]/projects/[projectId]/preview`.
 */
import { createHash } from 'node:crypto';
import { renderDocument } from '@platform/blocks';
import { WorkspaceError } from '@platform/workspaces';
import { builderService, requireUserId, withRequestContext, workspaces } from '@/lib/workspaces';

/** Fonts are copied into public/preview-fonts by scripts/copy-preview-fonts.mjs (same allow-list as the sites app). */
const PREVIEW_FONT_BASE = '/preview-fonts';

const styleSource = (css: string) => `'sha256-${createHash('sha256').update(css).digest('base64')}'`;

function previewPolicy(inlineStyles: readonly string[]): string {
  return [
    "default-src 'none'",
    `style-src ${inlineStyles.map(styleSource).join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; projectId: string; path?: string[] }> },
) {
  const { slug, projectId, path } = await params;
  const userId = await requireUserId();
  const ws = await (await workspaces()).resolveBySlug(userId, slug);
  if (!ws) return text('Not found', 404);
  try {
    const draft = await withRequestContext(async () =>
      (await builderService()).getDraft(userId, ws.id, projectId),
    );
    const segments = (path ?? []).filter((s) => /^[a-z0-9-]{1,40}$/.test(s));
    const doc = renderDocument({
      config: draft.config,
      path: `/${segments.join('/')}`,
      origin: new URL(request.url).origin,
      mode: 'draft',
      noindex: true,
      basePath: `/w/${ws.slug}/projects/${draft.projectId}/preview`,
      fontBase: PREVIEW_FONT_BASE,
      banner: 'Draft preview: not published',
    });
    if (doc.kind !== 'page') return text('This draft cannot be shown.', 422);
    return new Response(doc.html, {
      status: doc.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': previewPolicy(doc.inlineStyles),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'same-origin',
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return text(error.code === 'NO_DRAFT' ? 'This project has no site yet.' : 'Not found', 404);
    }
    throw error;
  }
}
