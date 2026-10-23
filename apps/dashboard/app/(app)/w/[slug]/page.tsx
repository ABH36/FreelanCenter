import type { Metadata } from 'next';
import Link from 'next/link';
import { currentWorkspace, requireUserId, workspaces } from '@/lib/workspaces';
import { Panel } from '@/components/ui';

export const metadata: Metadata = { title: 'Overview' };

/** FR-WS-02: usage overview. Plans and billing arrive in P6. */
export default async function WorkspaceOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const ws = await currentWorkspace((await params).slug);
  const overview = await (await workspaces()).getOverview(await requireUserId(), ws.id);
  const stats = [
    { label: 'Members', value: overview.members, href: `/w/${ws.slug}/members` },
    { label: 'Projects', value: overview.projects, href: `/w/${ws.slug}/projects` },
    ...(overview.openInvitations === null
      ? []
      : [{ label: 'Open invitations', value: overview.openInvitations, href: `/w/${ws.slug}/members` }]),
  ];
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ws.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          You are {ws.role === 'viewer' ? 'a' : 'an'} <span className="capitalize">{ws.role}</span> of this
          workspace.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="rounded-[var(--radius-base)] border border-slate-200 bg-white p-5 hover:border-slate-300"
          >
            <div className="text-sm text-slate-600">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</div>
          </Link>
        ))}
      </div>
      <Panel title="Plan" description="Every workspace is on the free plan while billing is being built.">
        <p className="text-sm text-slate-600">Plans, credits and usage limits arrive with billing.</p>
      </Panel>
    </>
  );
}
