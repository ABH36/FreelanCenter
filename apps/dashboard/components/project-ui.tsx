/** Small project display pieces (P1 S6). */
import { type ProjectStatus, STATUS_LABEL } from '@platform/workspaces';

const STATUS_STYLE: Record<ProjectStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  in_review: 'bg-amber-100 text-amber-900',
  approved: 'bg-sky-100 text-sky-900',
  live: 'bg-emerald-100 text-emerald-900',
  paused: 'bg-orange-100 text-orange-900',
  archived: 'bg-slate-200 text-slate-600',
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export const selectClass =
  'block w-full rounded-[var(--radius-base)] border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs';
