/**
 * "View demo" on a template card (P2 S10, acceptance C-13): a one-hour preview of the template as designed, for the
 * signed-in member, then a redirect to it. The slug is a selector resolved through the member's own memberships; a
 * non-member, an unknown slug and an unknown template all get 404. Registered with the IDOR harness as
 * `route:/w/[slug]/templates/[templateId]/demo`.
 */
import { isWorkspaceError } from '@platform/workspaces';
import { requireUserId, templateService, withRequestContext, workspaces } from '@/lib/workspaces';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; templateId: string }> },
) {
  const userId = await requireUserId();
  const { slug, templateId } = await params;
  const ws = await (await workspaces()).resolveBySlug(userId, slug);
  if (!ws) return new Response('Not found', { status: 404 });
  try {
    const url = await withRequestContext(async () =>
      (await templateService()).demoLink(userId, ws.id, templateId),
    );
    return new Response(null, {
      status: 303,
      headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (error) {
    if (isWorkspaceError(error)) return new Response('Not found', { status: 404 });
    throw error;
  }
}
