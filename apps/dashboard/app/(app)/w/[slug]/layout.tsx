import type { ReactNode } from 'react';
import { currentWorkspace } from '@/lib/workspaces';

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
  return (
    <div className="space-y-6">
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
