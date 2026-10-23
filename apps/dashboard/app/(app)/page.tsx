import type { Metadata } from 'next';
import Link from 'next/link';
import { getSession } from '@/lib/auth';
import { EmptyState } from '@/components/ui';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const session = await getSession();
  const firstName = session?.user.name.split(/\s+/)[0] ?? '';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome{firstName ? `, ${firstName}` : ''}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Your workspaces, projects and client sites will appear here.
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
      <EmptyState
        title="No workspace yet"
        body="A workspace holds your team, client projects and billing. Creating workspaces arrives in the next release."
      />
    </div>
  );
}
