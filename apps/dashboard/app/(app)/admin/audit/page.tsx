import type { Metadata } from 'next';
import Link from 'next/link';
import { adminService, requireAdmin } from '@/lib/admin';
import { type Search, buttonClass, inputClass, nextPage, one, when } from '../admin-ui';

export const metadata: Metadata = { title: 'Audit log · Admin' };

/**
 * Platform audit trail (SEC-17, FR-AUD-01): rows without a workspace (sign-in, sessions, step-ups, searches,
 * operator grants) and every row an admin wrote in any workspace. IP and user agent are not shown.
 */
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const principal = await requireAdmin();
  const sp = await searchParams;
  const filters = { action: one(sp.action), actor: one(sp.actor) };
  const { items, nextCursor } = await (
    await adminService()
  ).listAudit(principal, { action: filters.action, actorId: filters.actor, cursor: one(sp.cursor) });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Platform audit log</h1>
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter the audit log">
        <input
          name="action"
          defaultValue={filters.action}
          placeholder="Action, e.g. admin."
          aria-label="Action prefix"
          className={inputClass}
        />
        <input
          name="actor"
          defaultValue={filters.actor}
          placeholder="Actor user id"
          aria-label="Actor user id"
          className={`${inputClass} w-80 font-mono`}
        />
        <button type="submit" className={buttonClass}>
          Apply
        </button>
      </form>
      <div className="overflow-x-auto rounded-[var(--radius-base)] border border-slate-200 bg-white">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">When (UTC)</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No entries match.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{when(r.createdAt)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td
                    className={`px-3 py-2 text-xs ${r.result === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
                  >
                    {r.result}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.actorType}
                    {r.actorId ? ` ${r.actorId.slice(0, 8)}` : ''}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.targetType === 'workspace' && r.targetId ? (
                      <Link href={`/admin/workspaces/${r.targetId}`} className="hover:underline">
                        workspace
                      </Link>
                    ) : (
                      (r.targetType ?? '—')
                    )}
                  </td>
                  <td
                    className="max-w-xs truncate px-3 py-2 font-mono text-xs"
                    title={JSON.stringify(r.metadata)}
                  >
                    {Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ''}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {nextCursor ? (
        <Link
          href={nextPage(filters, nextCursor)}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          Older entries
        </Link>
      ) : null}
    </div>
  );
}
