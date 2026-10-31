import type { Metadata } from 'next';
import Link from 'next/link';
import { WorkspaceError } from '@platform/workspaces';
import { Alert } from '@/components/ui';
import { adminService, requireAdmin } from '@/lib/admin';
import { withRequestContext } from '@/lib/workspaces';
import { type Search, buttonClass, inputClass, nextPage, one, when } from '../admin-ui';

export const metadata: Metadata = { title: 'Workspaces · Admin' };

/** FR-ADM-01: workspaces, newest first. Search by id, address prefix or name; every search is audited. */
export default async function AdminWorkspacesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const principal = await requireAdmin();
  const sp = await searchParams;
  const filters = { q: one(sp.q), status: one(sp.status) };
  const service = await adminService();
  let result: Awaited<ReturnType<typeof service.listWorkspaces>> | null = null;
  let error: string | null = null;
  try {
    // In a request context, so the audit row of a search carries its correlation id.
    result = await withRequestContext(() =>
      service.listWorkspaces(principal, {
        query: filters.q,
        status: filters.status,
        cursor: one(sp.cursor),
      }),
    );
  } catch (e) {
    if (!(e instanceof WorkspaceError)) throw e;
    error = Object.values(e.fieldErrors)[0] ?? e.message;
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Search workspaces">
        <input
          name="q"
          defaultValue={filters.q}
          placeholder="Name, address or id"
          aria-label="Search"
          maxLength={100}
          className={`${inputClass} w-64`}
        />
        <select name="status" defaultValue={filters.status} aria-label="Status" className={inputClass}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <button type="submit" className={buttonClass}>
          Search
        </button>
      </form>
      <Alert>{error}</Alert>
      {result ? (
        <div className="overflow-x-auto rounded-[var(--radius-base)] border border-slate-200 bg-white">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Members</th>
                <th className="px-3 py-2 font-medium">Projects</th>
                <th className="px-3 py-2 font-medium">Created (UTC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                    No workspaces match.
                  </td>
                </tr>
              ) : (
                result.items.map((w) => (
                  <tr key={w.id}>
                    <td className="px-3 py-2">
                      <Link href={`/admin/workspaces/${w.id}`} className="font-medium hover:underline">
                        {w.name}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-slate-500">{w.slug}</span>
                    </td>
                    <td
                      className={`px-3 py-2 text-xs ${w.status === 'suspended' ? 'text-red-700' : 'text-emerald-700'}`}
                    >
                      {w.status}
                      {w.deletionScheduled ? ' · deletion scheduled' : ''}
                    </td>
                    <td className="px-3 py-2 text-xs">{w.memberCount}</td>
                    <td className="px-3 py-2 text-xs">{w.projectCount}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{when(w.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {result?.nextCursor ? (
        <Link
          href={nextPage(filters, result.nextCursor)}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          Older workspaces
        </Link>
      ) : null}
    </div>
  );
}
