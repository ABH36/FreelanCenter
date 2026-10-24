import type { Metadata } from 'next';
import Link from 'next/link';
import { PROJECT_CATEGORIES, PROJECT_STATUSES, STATUS_LABEL, parseStatusFilter } from '@platform/workspaces';
import { EmptyState } from '@/components/ui';
import { StatusBadge } from '@/components/project-ui';
import { currentWorkspace, projectService, requireUserId } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Projects' };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
const inputClass = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm';

/**
 * FR-PRJ-04: search, filters and pages are plain GET parameters (bookmarkable, no JS needed). The service
 * validates every one of them; the cursor is the last id of the previous page.
 */
export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const ws = await currentWorkspace((await params).slug);
  const userId = await requireUserId();
  const sp = await searchParams;
  const filters = {
    q: one(sp.q),
    status: parseStatusFilter(one(sp.status)),
    category: one(sp.category),
    client: one(sp.client),
    cursor: one(sp.cursor),
  };
  const { items, nextCursor } = await (await projectService()).listProjects(userId, ws.id, filters);
  const filtered = Boolean(filters.q || filters.category || filters.client || filters.status !== 'active');
  const nextHref = nextCursor
    ? `?${new URLSearchParams({ ...filters, cursor: nextCursor }).toString()}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        {ws.can['projects.create'] && ws.scope.writable ? (
          <Link
            href={`/w/${ws.slug}/projects/new`}
            className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            New project
          </Link>
        ) : null}
      </div>

      <form
        method="get"
        className="flex flex-wrap items-end gap-2"
        role="search"
        aria-label="Filter projects"
      >
        <input
          name="q"
          defaultValue={filters.q}
          placeholder="Search name or city"
          aria-label="Search"
          className={inputClass}
        />
        <input
          name="client"
          defaultValue={filters.client}
          placeholder="Client name, phone, e-mail"
          aria-label="Client"
          className={inputClass}
        />
        <select name="status" defaultValue={filters.status} aria-label="Status" className={inputClass}>
          <option value="active">All but archived</option>
          <option value="all">Everything</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select name="category" defaultValue={filters.category} aria-label="Category" className={inputClass}>
          <option value="">Any category</option>
          {Object.entries(PROJECT_CATEGORIES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Apply
        </button>
        {filtered ? (
          <Link
            href={`/w/${ws.slug}/projects`}
            className="px-2 py-1.5 text-sm text-slate-600 hover:underline"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {items.length === 0 ? (
        <EmptyState
          title={filtered || filters.cursor ? 'No matching projects' : 'No projects yet'}
          body={
            filtered || filters.cursor
              ? 'Try other filters.'
              : `Each project is one client's website in ${ws.name}. It gets its own address right away.`
          }
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-[var(--radius-base)] border border-slate-200 bg-white">
          {items.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <Link
                  href={`/w/${ws.slug}/projects/${p.id}`}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {p.name}
                </Link>
                <div className="truncate text-xs text-slate-500">
                  {[
                    p.category ? PROJECT_CATEGORIES[p.category as keyof typeof PROJECT_CATEGORIES] : null,
                    p.city,
                    p.clientName,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No details yet'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500" title="Platform address">
                  {p.health.subdomain ? p.health.subdomain.hostname : 'No address'}
                </span>
                {p.health.pendingReview ? (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">Review pending</span>
                ) : null}
                <StatusBadge status={p.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {nextHref ? (
        <div>
          <Link href={nextHref} className="text-sm font-medium text-[var(--color-primary)] hover:underline">
            Next page
          </Link>
        </div>
      ) : null}
    </div>
  );
}
