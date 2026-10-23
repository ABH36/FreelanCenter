'use client';
import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';

export function UserMenu({ name, email, mfa }: { name: string; email: string; mfa: boolean }) {
  const [open, setOpen] = useState(false);
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full p-1 pr-3 text-sm hover:bg-slate-50"
      >
        <span className="grid size-8 place-items-center rounded-full bg-slate-900 text-xs font-semibold text-white">
          {initials || '?'}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{name}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-2 w-64 rounded-[var(--radius-base)] border border-slate-200 bg-white p-1 shadow-lg"
        >
          <div className="px-3 py-2">
            <div className="truncate text-sm font-medium">{name}</div>
            <div className="truncate text-xs text-slate-500">{email}</div>
            {mfa ? null : <div className="mt-1 text-xs text-amber-700">Two-factor authentication is off</div>}
          </div>
          <Link
            role="menuitem"
            href="/settings/security"
            className="block rounded-md px-3 py-2 text-sm hover:bg-slate-50"
            onClick={() => setOpen(false)}
          >
            Security settings
          </Link>
          <button
            role="menuitem"
            type="button"
            className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50"
            onClick={async () => {
              await authClient.signOut();
              window.location.assign('/sign-in');
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
