import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { AppNav } from './app-nav';
import { UserMenu } from './user-menu';

/**
 * Signed-in shell. The session is verified on the server for every request (no client-side gate): a missing,
 * expired or revoked session goes to /sign-in.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { user } = session;
  return (
    <div className="min-h-dvh bg-[var(--color-surface)] md:grid md:grid-cols-[15rem_1fr]">
      <aside className="border-b border-slate-200 bg-white md:min-h-dvh md:border-r md:border-b-0">
        <div className="flex h-14 items-center gap-2 px-5 text-sm font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-[var(--color-primary)] text-white">
            P
          </span>
          Platform
        </div>
        <AppNav />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="text-sm text-slate-500">No workspace yet</div>
          <UserMenu name={user.name} email={user.email} mfa={Boolean(user.twoFactorEnabled)} />
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
