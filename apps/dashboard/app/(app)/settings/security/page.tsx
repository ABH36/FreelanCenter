import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth, getSession } from '@/lib/auth';
import { ChangePassword, SignOutEverywhere, TwoFactorSettings } from './security-forms';

export const metadata: Metadata = { title: 'Security' };

export default async function SecurityPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const auth = await getAuth();
  const accounts = await auth.api.listUserAccounts({ headers: await headers() });
  const hasPassword = accounts.some((a) => a.providerId === 'credential');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="mt-1 text-sm text-slate-600">Manage how you sign in and where you are signed in.</p>
      </div>
      <TwoFactorSettings enabled={Boolean(session.user.twoFactorEnabled)} hasPassword={hasPassword} />
      {hasPassword ? <ChangePassword /> : null}
      <SignOutEverywhere />
    </div>
  );
}
