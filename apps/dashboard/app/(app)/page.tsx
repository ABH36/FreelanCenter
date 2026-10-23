import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { ACTIVE_WORKSPACE_COOKIE, PENDING_INVITE_COOKIE, myWorkspaces } from '@/lib/workspaces';
import { Panel } from '@/components/ui';
import { CreateWorkspaceForm } from './workspaces/new/create-workspace-form';

export const metadata: Metadata = { title: 'Workspaces' };

/**
 * Entry point after sign-in: a pending invitation first, then the last workspace used (if still a member), then
 * the first membership; with none, the user creates their first workspace here.
 */
export default async function HomePage() {
  const jar = await cookies();
  const pendingInvite = jar.get(PENDING_INVITE_COOKIE)?.value;
  if (pendingInvite && /^[A-Za-z0-9_-]{43}$/.test(pendingInvite)) redirect(`/invite/${pendingInvite}`);

  const workspaces = await myWorkspaces();
  const remembered = jar.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const target = workspaces.find((w) => w.slug === remembered) ?? workspaces[0];
  if (target) redirect(`/w/${target.slug}`);

  const session = await getSession();
  const firstName = session?.user.name.split(/\s+/)[0] ?? '';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome{firstName ? `, ${firstName}` : ''}</h1>
        <p className="mt-1 text-sm text-slate-600">
          A workspace holds your team, client projects and billing. Create one to get started, or open an
          invitation link you received.
        </p>
      </div>
      {session?.user.twoFactorEnabled ? null : (
        <div className="flex flex-col gap-3 rounded-[var(--radius-base)] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
          <span>Protect your account: turn on two-factor authentication.</span>
          <Link href="/settings/security" className="font-medium underline">
            Set up now
          </Link>
        </div>
      )}
      <Panel title="Create your first workspace">
        <CreateWorkspaceForm />
      </Panel>
    </div>
  );
}
