import type { Metadata } from 'next';
import Link from 'next/link';
import { WorkspaceError } from '@platform/workspaces';
import { Alert } from '@/components/ui';
import { adminService, requireAdmin } from '@/lib/admin';
import { withRequestContext } from '@/lib/workspaces';
import { type Search, buttonClass, inputClass, nextPage, one, when } from '../admin-ui';

export const metadata: Metadata = { title: 'Users · Admin' };

/**
 * FR-ADM-01: users, newest first. Data minimisation: masked addresses and no names; search only by user id or
 * one exact e-mail address (no fragments, so the list cannot be used to enumerate addresses). Searches are audited.
 */
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const principal = await requireAdmin();
  const sp = await searchParams;
  const filters = { q: one(sp.q) };
  const service = await adminService();
  let result: Awaited<ReturnType<typeof service.listUsers>> | null = null;
  let error: string | null = null;
  try {
    // In a request context, so the audit row of a search carries its correlation id.
    result = await withRequestContext(() =>
      service.listUsers(principal, { query: filters.q, cursor: one(sp.cursor) }),
    );
  } catch (e) {
    if (!(e instanceof WorkspaceError)) throw e;
    error = Object.values(e.fieldErrors)[0] ?? e.message;
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Search users">
        <input
          name="q"
          defaultValue={filters.q}
          placeholder="Exact e-mail address or user id"
          aria-label="Search"
          maxLength={254}
          className={`${inputClass} w-72`}
        />
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
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Verified</th>
                <th className="px-3 py-2 font-medium">2FA</th>
                <th className="px-3 py-2 font-medium">Workspaces</th>
                <th className="px-3 py-2 font-medium">Created (UTC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                    No users match.
                  </td>
                </tr>
              ) : (
                result.items.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2">
                      {u.emailMasked}
                      {u.platformAdmin ? (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                          admin
                        </span>
                      ) : null}
                      <span className="block font-mono text-xs text-slate-500">{u.id}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">{u.status}</td>
                    <td className="px-3 py-2 text-xs">{u.emailVerified ? 'yes' : 'no'}</td>
                    <td className="px-3 py-2 text-xs">{u.twoFactorEnabled ? 'on' : 'off'}</td>
                    <td className="px-3 py-2 text-xs">{u.workspaceCount}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{when(u.createdAt)}</td>
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
          Older users
        </Link>
      ) : null}
    </div>
  );
}
