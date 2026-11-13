import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { cookies } from 'next/headers';
import { ACTIVE_WORKSPACE_COOKIE, myWorkspaces } from '@/lib/workspaces';
import { AppNav } from './app-nav';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';
import { BRAND_NAME } from '@/lib/brand';

/**
 * Signed-in shell. The session is verified on the server for every request (no client-side gate): a missing,
 * expired or revoked session goes to /sign-in. The switcher lists the user's memberships (FR-AUTH-08); which one
 * is current comes from the `/w/<slug>` route, and that page re-checks membership itself.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { user } = session;
  const memberships = (await myWorkspaces()).map((w) => ({ name: w.name, slug: w.slug, role: w.role }));
  // Account pages (Security) keep showing the workspace the person was in, as long as they are still a member of it.
  const remembered = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const fallbackSlug = memberships.some((m) => m.slug === remembered) ? (remembered ?? null) : null;
  return (
    <div className="min-h-dvh bg-[var(--color-surface)] md:grid md:grid-cols-[15rem_1fr]">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="border-b border-slate-200 bg-white md:min-h-dvh md:border-r md:border-b-0">
        <div className="flex h-14 items-center gap-2 px-5 text-sm font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-[var(--color-primary)] text-white">
            F
          </span>
          {BRAND_NAME}
        </div>
        <AppNav fallbackSlug={fallbackSlug} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <WorkspaceSwitcher workspaces={memberships} fallbackSlug={fallbackSlug} />
          <UserMenu name={user.name} email={user.email} mfa={Boolean(user.twoFactorEnabled)} />
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 outline-none sm:px-6"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
