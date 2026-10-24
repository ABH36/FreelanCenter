/**
 * FR-AUD-01 export: the workspace's audit log as CSV, owners only. The slug is a selector resolved through the
 * member's own memberships; a non-member and an unknown slug both get 404. The export is audited by the service.
 * Registered with the IDOR harness as `route:/w/[slug]/audit/export`.
 */
import { WorkspaceError } from '@platform/workspaces';
import { auditService, requireUserId, withRequestContext, workspaces } from '@/lib/workspaces';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const userId = await requireUserId();
  const ws = await (await workspaces()).resolveBySlug(userId, (await params).slug);
  if (!ws) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  const filters = Object.fromEntries(
    ['action', 'result', 'actorId', 'from', 'to'].map((k) => [k, url.searchParams.get(k) ?? undefined]),
  );
  try {
    const { csv } = await withRequestContext(async () =>
      (await auditService()).exportAuditLog(userId, { workspaceId: ws.id, filters }),
    );
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-${ws.slug}-${date}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return new Response(error.message, { status: error.code === 'FORBIDDEN' ? 403 : 404 });
    }
    throw error;
  }
}
