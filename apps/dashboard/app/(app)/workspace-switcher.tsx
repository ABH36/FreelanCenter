'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { switchWorkspaceAction } from '@/app/actions/workspaces';

export interface SwitcherItem {
  name: string;
  slug: string;
  role: string;
}

/** The slug of the workspace route being shown, if any (`/w/<slug>/...`). */
export function currentSlug(pathname: string): string | null {
  return /^\/w\/([a-z0-9-]+)/.exec(pathname)?.[1] ?? null;
}

/** FR-AUTH-08: switch between memberships. Switching posts to the server, which re-checks membership. */
export function WorkspaceSwitcher({ workspaces }: { workspaces: SwitcherItem[] }) {
  const [open, setOpen] = useState(false);
  const slug = currentSlug(usePathname());
  const current = workspaces.find((w) => w.slug === slug);
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex max-w-64 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50"
      >
        <span className="truncate font-medium">{current?.name ?? 'Select a workspace'}</span>
        {current ? <span className="text-xs text-slate-500 capitalize">{current.role}</span> : null}
        <span aria-hidden className="text-slate-400">
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 z-10 mt-2 w-72 rounded-[var(--radius-base)] border border-slate-200 bg-white p-1 shadow-lg"
        >
          {workspaces.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-500">You are not in any workspace yet.</div>
          ) : (
            workspaces.map((w) => (
              <form key={w.slug} action={switchWorkspaceAction}>
                <input type="hidden" name="slug" value={w.slug} />
                <button
                  role="menuitem"
                  type="submit"
                  aria-current={w.slug === slug ? 'true' : undefined}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 aria-[current]:bg-slate-100"
                >
                  <span className="truncate">{w.name}</span>
                  <span className="text-xs text-slate-500 capitalize">{w.role}</span>
                </button>
              </form>
            ))
          )}
          <div className="my-1 h-px bg-slate-100" />
          <Link
            role="menuitem"
            href="/workspaces/new"
            onClick={() => setOpen(false)}
            className="block rounded-md px-3 py-2 text-sm font-medium text-[var(--color-primary)] hover:bg-slate-50"
          >
            + Create workspace
          </Link>
        </div>
      ) : null}
    </div>
  );
}
