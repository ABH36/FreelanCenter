'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { currentSlug } from './workspace-switcher';

/** Workspace items appear inside a workspace route; the account item is always there. */
export function AppNav() {
  const pathname = usePathname();
  const slug = currentSlug(pathname);
  const items = [
    ...(slug
      ? [
          { href: `/w/${slug}`, label: 'Overview', exact: true },
          { href: `/w/${slug}/projects`, label: 'Projects', exact: false },
          { href: `/w/${slug}/members`, label: 'Members', exact: false },
          { href: `/w/${slug}/settings`, label: 'Settings', exact: false },
        ]
      : [{ href: '/', label: 'Workspaces', exact: true }]),
    { href: '/settings/security', label: 'Account security', exact: false },
  ];
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${
              active ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
