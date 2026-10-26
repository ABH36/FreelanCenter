import type { ReactNode } from 'react';
import Link from 'next/link';
import { currentWorkspace, notificationService, requireUserId } from '@/lib/workspaces';

/**
 * FR-WS-03: every workspace has its own dashboard route. The slug in the URL is only a selector: a non-member and
 * an unknown slug both get 404 (`currentWorkspace`).
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const ws = await currentWorkspace((await params).slug);
  const unread = await (await notificationService()).unreadCount(await requireUserId(), ws.id);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-end gap-3 text-sm">
        <Link href={`/w/${ws.slug}/notifications`} className="text-slate-600 hover:underline">
          Notifications
          {unread ? (
            <span className="ml-1 rounded-full bg-[var(--color-primary)] px-1.5 text-xs text-white">
              {unread}
            </span>
          ) : null}
        </Link>
        {ws.can['audit.view'] ? (
          <Link href={`/w/${ws.slug}/audit`} className="text-slate-600 hover:underline">
            Audit log
          </Link>
        ) : null}
      </div>
      {ws.status === 'suspended' ? (
        <div
          role="status"
          className="rounded-[var(--radius-base)] border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          This workspace is suspended. You can view it, but changes are blocked. Contact support.
        </div>
      ) : null}
      {ws.deletionScheduledFor ? (
        <div
          role="status"
          className="rounded-[var(--radius-base)] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          This workspace is scheduled for deletion on {ws.deletionScheduledFor.toUTCString()}. Changes are
          blocked until then.{ws.can['workspace.delete'] ? ' You can cancel the deletion in Settings.' : ''}
        </div>
      ) : null}
      {children}
    </div>
  );
}
