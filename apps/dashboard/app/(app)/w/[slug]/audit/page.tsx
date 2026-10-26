import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/ui';
import { auditService, currentWorkspace, requireUserId } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Audit log' };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
const inputClass = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm';

/**
 * FR-AUD-01 viewer: owners only (`audit.view`, S5 decision D3). Filters are GET parameters validated by the
 * service; the export link carries the same filters and is itself audited.
 */
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const ws = await currentWorkspace((await params).slug);
  if (!ws.can['audit.view']) notFound();
  const userId = await requireUserId();
  const sp = await searchParams;
  const filters = { action: one(sp.action), result: one(sp.result), from: one(sp.from), to: one(sp.to) };
  const service = await auditService();
  const [{ items, nextCursor }, letters] = await Promise.all([
    service.listAuditLog(userId, ws.id, { ...filters, cursor: one(sp.cursor) }),
    service.listDeadLetters(userId, ws.id),
  ]);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <a
          href={`/w/${ws.slug}/audit/export${query ? `?${query}` : ''}`}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Export CSV
        </a>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter the audit log">
        <input
          name="action"
          defaultValue={filters.action}
          placeholder="Action, e.g. project."
          aria-label="Action prefix"
          className={inputClass}
        />
        <select name="result" defaultValue={filters.result} aria-label="Result" className={inputClass}>
          <option value="">Any result</option>
          <option value="success">Success</option>
          <option value="denied">Denied</option>
          <option value="failure">Failure</option>
        </select>
        <label className="text-xs text-slate-600">
          From <input type="date" name="from" defaultValue={filters.from} className={inputClass} />
        </label>
        <label className="text-xs text-slate-600">
          To <input type="date" name="to" defaultValue={filters.to} className={inputClass} />
        </label>
        <button
          type="submit"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Apply
        </button>
      </form>

      <div className="overflow-x-auto rounded-[var(--radius-base)] border border-slate-200 bg-white">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">When (UTC)</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No entries match.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-xs">
                    {r.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td
                    className={`px-3 py-2 text-xs ${r.result === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
                  >
                    {r.result}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.actorName ?? (r.actorId ? r.actorId.slice(0, 8) : r.actorType)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.projectId ? (
                      <Link href={`/w/${ws.slug}/projects/${r.projectId}`} className="hover:underline">
                        {r.targetType}
                      </Link>
                    ) : (
                      (r.targetType ?? '—')
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {nextCursor ? (
        <Link
          href={`?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), cursor: nextCursor }).toString()}`}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          Older entries
        </Link>
      ) : null}

      <Panel
        title="Failed background jobs"
        description="E-mails and other jobs that failed after every retry."
      >
        {letters.length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {letters.map((l) => (
              <li key={l.id}>
                <span className="font-mono">{l.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</span>{' '}
                {l.functionId} {l.targetType ? `(${l.targetType})` : ''}: {l.error}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
