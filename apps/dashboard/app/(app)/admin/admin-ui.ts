/** Small helpers shared by the admin console pages (server components). */
export type Search = Record<string, string | string[] | undefined>;
export const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
export const inputClass = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm';
export const buttonClass =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50';
export const when = (d: Date | null) => (d ? d.toISOString().slice(0, 19).replace('T', ' ') : '—');
/** `?a=1&cursor=…` for the next page, keeping only non-empty filters. */
export const nextPage = (filters: Record<string, string>, cursor: string) =>
  `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), cursor }).toString()}`;
