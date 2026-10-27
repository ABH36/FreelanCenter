import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { adminContext } from '@/lib/admin';

export const metadata: Metadata = { title: 'Admin console', robots: { index: false, follow: false } };

/**
 * Admin console shell (P1 S8). The guard runs here and again in every page and action: 404 for anyone who is
 * not a platform admin with TOTP on a live session. Pages below the step-up page also need a step-up.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { state } = await adminContext();
  const until = state.stepUpUntil;
  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-base)] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">Admin console</p>
        <p className="mt-0.5 text-xs">
          Every search, view and change here is recorded in the platform audit log with your account.
          {until ? ` Step-up valid until ${until.toISOString().slice(11, 16)} UTC.` : ''}
        </p>
      </div>
      {until ? (
        <nav aria-label="Admin" className="flex gap-1 border-b border-slate-200 pb-2 text-sm">
          {[
            { href: '/admin/workspaces', label: 'Workspaces' },
            { href: '/admin/users', label: 'Users' },
            { href: '/admin/audit', label: 'Audit log' },
          ].map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md px-3 py-1.5 hover:bg-slate-100">
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {children}
    </div>
  );
}
