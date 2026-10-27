import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/ui';
import { adminService, requireAdmin } from '@/lib/admin';
import { when } from '../../admin-ui';
import { StatusForm } from './status-form';

export const metadata: Metadata = { title: 'Workspace · Admin' };

/**
 * One workspace for a suspend decision (FR-ADM-02). Data minimisation: owners as masked addresses, projects as
 * status and public host names only; no project names, client contacts or member list. The view is audited.
 */
export default async function AdminWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAdmin();
  const ws = await (await adminService()).getWorkspace(principal, (await params).id);
  if (!ws) notFound();
  const suspended = ws.status === 'suspended';

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/workspaces" className="text-sm text-slate-600 hover:underline">
          ← Workspaces
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{ws.name}</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          {ws.slug} · {ws.id}
        </p>
      </div>

      <dl className="grid gap-3 rounded-[var(--radius-base)] border border-slate-200 bg-white p-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-slate-500">Status</dt>
          <dd className={suspended ? 'font-medium text-red-700' : 'font-medium text-emerald-700'}>
            {ws.status}
            {suspended ? ` since ${when(ws.suspendedAt)} UTC` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Deletion</dt>
          <dd>
            {ws.deletionScheduledAt ? `scheduled for ${when(ws.deletionScheduledAt)} UTC` : 'not requested'}
          </dd>
        </div>
        {suspended ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-slate-500">Suspension reason</dt>
            <dd className="whitespace-pre-wrap">{ws.suspendedReason}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-slate-500">Members</dt>
          <dd>{ws.memberCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Owners</dt>
          <dd className="space-y-0.5">
            {ws.owners.map((o) => (
              <p key={o.userId}>
                <Link href={`/admin/users?q=${o.userId}`} className="hover:underline">
                  {o.email}
                </Link>
              </p>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Created</dt>
          <dd>{when(ws.createdAt)} UTC</dd>
        </div>
      </dl>

      <Panel
        title={suspended ? 'Reactivate workspace' : 'Suspend workspace'}
        description={
          suspended
            ? 'The workspace can be changed again and its sites come back.'
            : 'Members keep read access but cannot change anything; every site of the workspace shows the maintenance page within seconds.'
        }
      >
        <StatusForm workspaceId={ws.id} to={suspended ? 'active' : 'suspended'} />
      </Panel>

      <Panel title="Projects" description="Status and public addresses only (at most 200, newest first).">
        {ws.projects.length === 0 ? (
          <p className="text-sm text-slate-600">No projects.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {ws.projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-mono text-xs">{p.hosts.join(', ') || '(no address)'}</span>
                <span className="text-xs text-slate-600">{p.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
