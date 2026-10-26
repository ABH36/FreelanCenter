import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CATEGORY_NAMES,
  NOTIFICATION_CATEGORIES,
  type NotificationRow,
  STATUS_LABEL,
  isProjectStatus,
} from '@platform/workspaces';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
  saveNotificationPreferencesAction,
} from '@/app/actions/notifications';
import { ActionForm, SmallButton } from '@/components/action-form';
import { EmptyState, Panel } from '@/components/ui';
import { currentWorkspace, notificationService, projectService, requireUserId } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Notifications' };

function describe(n: NotificationRow, projectName: string | undefined) {
  const project = projectName ? `"${projectName}"` : 'A project';
  if (n.type === 'project.review_requested') return `${project} is waiting for your review.`;
  if (n.type === 'project.status_changed') {
    const to = isProjectStatus(n.payload.to) ? STATUS_LABEL[n.payload.to] : 'a new status';
    return `${project} is now ${to}.`;
  }
  if (n.type === 'workspace.invitation_accepted') return 'Someone accepted your invitation and joined.';
  return 'Update';
}

/** FR-NOT-01: the member's own in-app notifications and their per-category choices. */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ws = await currentWorkspace((await params).slug);
  const userId = await requireUserId();
  const cursor = (await searchParams).cursor;
  const service = await notificationService();
  const [{ items, nextCursor }, prefs] = await Promise.all([
    service.listNotifications(userId, ws.id, { cursor: typeof cursor === 'string' ? cursor : undefined }),
    service.getPreferences(userId, ws.id),
  ]);
  // Project names for the messages, in one RLS-scoped query.
  const names = await (
    await projectService()
  ).projectNames(
    userId,
    ws.id,
    items.map((n) => n.payload.projectId),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        {items.some((n) => !n.readAt) ? (
          <ActionForm action={markAllNotificationsReadAction} hidden={{ workspaceId: ws.id }}>
            <SmallButton type="submit">Mark all as read</SmallButton>
          </ActionForm>
        ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState title="Nothing new" body="Project reviews and status changes will show up here." />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-[var(--radius-base)] border border-slate-200 bg-white">
          {items.map((n) => {
            const projectId = typeof n.payload.projectId === 'string' ? n.payload.projectId : null;
            return (
              <li
                key={n.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className={`text-sm ${n.readAt ? 'text-slate-600' : 'font-medium'}`}>
                    {projectId && names.has(projectId) ? (
                      <Link href={`/w/${ws.slug}/projects/${projectId}`} className="hover:underline">
                        {describe(n, names.get(projectId))}
                      </Link>
                    ) : (
                      describe(n, undefined)
                    )}
                  </p>
                  <p className="text-xs text-slate-500">{n.createdAt.toUTCString()}</p>
                </div>
                {!n.readAt ? (
                  <ActionForm
                    action={markNotificationReadAction}
                    hidden={{ workspaceId: ws.id, notificationId: n.id }}
                  >
                    <SmallButton type="submit">Mark read</SmallButton>
                  </ActionForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor ? (
        <Link
          href={`?cursor=${nextCursor}`}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          Older
        </Link>
      ) : null}

      <Panel
        title="Preferences"
        description="What you hear about in this workspace. E-mails go to your sign-in address."
      >
        {ws.scope.writable ? (
          <ActionForm
            action={saveNotificationPreferencesAction}
            hidden={{ workspaceId: ws.id }}
            className="space-y-3"
          >
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="py-1 font-medium">Event</th>
                  <th className="py-1 font-medium">In the dashboard</th>
                  <th className="py-1 font-medium">E-mail</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORY_NAMES.map((c) => (
                  <tr key={c} className="border-t border-slate-100">
                    <td className="py-2">{NOTIFICATION_CATEGORIES[c].label}</td>
                    <td className="py-2">
                      <input
                        type="checkbox"
                        name={`${c}:in_app`}
                        defaultChecked={prefs[c].inApp}
                        aria-label={`${NOTIFICATION_CATEGORIES[c].label}: in the dashboard`}
                      />
                    </td>
                    <td className="py-2">
                      {NOTIFICATION_CATEGORIES[c].emailAvailable ? (
                        <input
                          type="checkbox"
                          name={`${c}:email`}
                          defaultChecked={prefs[c].email}
                          aria-label={`${NOTIFICATION_CATEGORIES[c].label}: e-mail`}
                        />
                      ) : (
                        <span className="text-xs text-slate-400">not available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <SmallButton type="submit">Save preferences</SmallButton>
          </ActionForm>
        ) : (
          <p className="text-sm text-slate-600">
            Preferences cannot be changed while this workspace is read-only.
          </p>
        )}
      </Panel>
    </div>
  );
}
