import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  type DiffEntry,
  type HistoryVersion,
  type VersionComparison,
  type VersionSummary,
  WorkspaceError,
  isWorkspaceError,
} from '@platform/workspaces';
import { Panel } from '@/components/ui';
import {
  builderService,
  currentWorkspace,
  projectService,
  publishingService,
  requireUserId,
} from '@/lib/workspaces';
import { RestoreButton, RollbackButton } from './history-actions';

export const metadata: Metadata = { title: 'Version history' };

const when = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

const kindLabel = (kind: 'live' | 'staging') => (kind === 'live' ? 'Live' : 'Staging');
const versionName = (v: VersionSummary) => `Version ${v.number ?? '?'}`;

const CHANGE_WORDS: Record<DiffEntry['change'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
  hidden: 'Hidden',
  shown: 'Shown again',
};

type Search = { kind?: string; after?: string; from?: string; to?: string; path?: string };

const ID = /^[0-9a-f-]{36}$/i;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * P3 S7b (FR-PUB-03; module 06; plan approved by the Owner 2026-11-16): every published version of a project with
 * who, when and the note, a comparison of two versions (what changed, field by field, and both versions side by
 * side), one-click rollback of Live (owners and admins) and "restore into the draft" (owners, admins, editors).
 * The project id and the version ids in the URL are selectors only: the services authorize and RLS scopes every
 * read; another workspace's project is the same 404 as an unknown one. Registered with the IDOR harness as
 * `page:/w/[slug]/projects/[projectId]/history` (and its comparison).
 */
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, projectId } = await params;
  const raw = await searchParams;
  const search: Search = {
    kind: one(raw.kind),
    after: one(raw.after),
    from: one(raw.from),
    to: one(raw.to),
    path: one(raw.path),
  };
  const ws = await currentWorkspace(slug);
  const userId = await requireUserId();
  const project = await (
    await projectService()
  )
    .getProject(userId, ws.id, projectId)
    .catch((error: unknown) => {
      if (error instanceof WorkspaceError && error.code === 'NOT_FOUND') notFound();
      throw error;
    });
  const kind = search.kind === 'live' || search.kind === 'staging' ? search.kind : 'all';
  const publishing = await publishingService();
  const history = await publishing
    .history(userId, {
      workspaceId: ws.id,
      projectId: project.id,
      kind,
      ...(search.after && ID.test(search.after) ? { after: search.after } : {}),
    })
    .catch((error: unknown) => {
      // A stale "older" cursor (for example from another filter) starts again from the newest.
      if (isWorkspaceError(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    });
  const listing =
    history ?? (await publishing.history(userId, { workspaceId: ws.id, projectId: project.id, kind }));

  let comparison: VersionComparison | null = null;
  let compareProblem = '';
  if (search.from && search.to) {
    try {
      if (!ID.test(search.from) || !ID.test(search.to)) throw new WorkspaceError('NOT_FOUND');
      comparison = await publishing.compare(userId, {
        workspaceId: ws.id,
        projectId: project.id,
        from: search.from,
        to: search.to,
      });
    } catch (error) {
      if (!isWorkspaceError(error)) throw error;
      compareProblem =
        error.code === 'VERSION_UNREADABLE' ? error.message : 'Those two versions cannot be compared.';
    }
  }

  const draftRevision = await (
    await builderService()
  )
    .getDraft(userId, ws.id, project.id)
    .then((d) => d.revision)
    .catch((error: unknown) => {
      if (isWorkspaceError(error) && error.code === 'NO_DRAFT') return null;
      throw error;
    });

  const open = project.status !== 'archived' && ws.scope.writable;
  const canRollback = ws.can['site.publish'] && open;
  const canRestore = ws.can['draft.edit'] && open && draftRevision !== null;
  const base = `/w/${ws.slug}/projects/${project.id}/history`;
  const href = (q: Search) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const target = { workspaceId: ws.id, projectId: project.id };
  const versions = listing.versions;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/w/${ws.slug}/projects/${project.id}`}
          className="text-sm text-slate-600 hover:underline"
        >
          ← {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Version history</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Every publish keeps a copy of the site that never changes. Compare two copies, put an earlier one
          back on Live, or bring one back into the editor to keep working from it.
        </p>
        <Link
          href={`/w/${ws.slug}/projects/${project.id}/editor`}
          className="mt-3 inline-flex rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Open the editor
        </Link>
      </div>

      {comparison ? (
        <Comparison
          comparison={comparison}
          slug={ws.slug}
          path={search.path && /^\/[a-z0-9/-]{0,120}$/.test(search.path) ? search.path : '/'}
          pathHref={(path) => href({ ...search, path })}
          closeHref={href({ kind: search.kind, after: search.after })}
        />
      ) : null}
      {compareProblem ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {compareProblem}
        </p>
      ) : null}

      <Panel
        title="Published versions"
        description="Newest first. Live is the public website; Staging is the review copy your client sees through a review link."
      >
        <div className="space-y-4">
          <nav aria-label="Filter versions" className="flex flex-wrap gap-2 text-sm">
            {(['all', 'live', 'staging'] as const).map((k) => (
              <Link
                key={k}
                href={href({ kind: k === 'all' ? undefined : k })}
                aria-current={kind === k ? 'page' : undefined}
                className={`rounded-md border px-3 py-1 ${
                  kind === k
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 hover:bg-slate-50'
                }`}
              >
                {k === 'all' ? 'All' : kindLabel(k)}
              </Link>
            ))}
          </nav>

          {versions.length >= 2 ? (
            <form method="get" action={base} className="flex flex-wrap items-end gap-2 text-sm">
              {search.kind ? <input type="hidden" name="kind" value={search.kind} /> : null}
              {search.after ? <input type="hidden" name="after" value={search.after} /> : null}
              <label className="space-y-1">
                <span className="block font-medium">Compare</span>
                <select
                  name="from"
                  defaultValue={comparison?.from.id ?? versions[1]!.id}
                  className="rounded-md border border-slate-300 px-2 py-1.5"
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {versionName(v)} ({kindLabel(v.kind)})
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block font-medium">with</span>
                <select
                  name="to"
                  defaultValue={comparison?.to.id ?? versions[0]!.id}
                  className="rounded-md border border-slate-300 px-2 py-1.5"
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {versionName(v)} ({kindLabel(v.kind)})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-50"
              >
                Compare
              </button>
            </form>
          ) : null}

          {versions.length === 0 ? (
            <p className="text-sm text-slate-700">
              {kind === 'all'
                ? 'Nothing has been published yet. Publish from the editor; every publish appears here.'
                : `No ${kindLabel(kind)} versions yet.`}
            </p>
          ) : (
            <ol
              className="divide-y divide-slate-200 rounded-md border border-slate-200"
              aria-label="Versions"
            >
              {versions.map((v, i) => (
                <VersionRow
                  key={v.id}
                  v={v}
                  older={versions[i + 1] ?? null}
                  liveVersionId={listing.liveVersionId}
                  compareHref={(from, to) => href({ kind: search.kind, after: search.after, from, to })}
                  rollback={
                    canRollback &&
                    v.kind === 'live' &&
                    listing.liveVersionId &&
                    v.id !== listing.liveVersionId ? (
                      <RollbackButton
                        target={target}
                        versionId={v.id}
                        versionNumber={v.number}
                        expectedLiveVersionId={listing.liveVersionId}
                        liveNumber={versions.find((x) => x.id === listing.liveVersionId)?.number ?? null}
                      />
                    ) : null
                  }
                  restore={
                    canRestore && draftRevision !== null ? (
                      <RestoreButton
                        target={target}
                        slug={ws.slug}
                        versionId={v.id}
                        versionNumber={v.number}
                        expectedRevision={draftRevision}
                      />
                    ) : null
                  }
                />
              ))}
            </ol>
          )}

          <div className="flex flex-wrap gap-3 text-sm">
            {search.after ? (
              <Link href={href({ kind: search.kind })} className="underline">
                Back to the newest
              </Link>
            ) : null}
            {listing.next ? (
              <Link href={href({ kind: search.kind, after: listing.next })} className="underline">
                Older versions
              </Link>
            ) : null}
          </div>
          {!canRollback && ws.can['site.publish'] === false ? (
            <p className="text-xs text-slate-700">
              Only owners and admins can put an earlier version back on Live.
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function VersionRow({
  v,
  older,
  liveVersionId,
  compareHref,
  rollback,
  restore,
}: {
  v: HistoryVersion;
  older: HistoryVersion | null;
  liveVersionId: string | null;
  compareHref: (from: string, to: string) => string;
  rollback: ReactNode;
  restore: ReactNode;
}) {
  return (
    <li className="space-y-2 p-3 text-sm" data-testid={`version-${v.number ?? v.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{versionName(v)}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            v.kind === 'live' ? 'bg-emerald-50 text-emerald-800' : 'bg-sky-50 text-sky-800'
          }`}
        >
          {kindLabel(v.kind)}
        </span>
        {v.current ? (
          <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-white">
            Now on {kindLabel(v.current)}
          </span>
        ) : null}
        <span className="text-slate-700">
          {when(v.publishedAt)}
          {v.publishedByName ? ` · ${v.publishedByName}` : ''}
        </span>
      </div>
      {v.note ? <p className="text-slate-800">“{v.note}”</p> : null}
      <div className="flex flex-wrap gap-2">
        {older ? (
          <Link
            href={compareHref(older.id, v.id)}
            className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
          >
            Compare with {versionName(older)}
          </Link>
        ) : null}
        {liveVersionId && liveVersionId !== v.id ? (
          <Link
            href={compareHref(v.id, liveVersionId)}
            className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
          >
            Compare with Live
          </Link>
        ) : null}
        {restore}
        {rollback}
      </div>
    </li>
  );
}

function Comparison({
  comparison,
  slug,
  path,
  pathHref,
  closeHref,
}: {
  comparison: VersionComparison;
  slug: string;
  path: string;
  pathHref: (path: string) => string;
  closeHref: string;
}) {
  const { from, to, diff } = comparison;
  const frame = (v: VersionSummary) => `/version-preview/${slug}/${v.id}${path === '/' ? '' : path}`;
  const describe = (v: VersionSummary) =>
    `${versionName(v)} (${kindLabel(v.kind)}, ${when(v.publishedAt)}${v.publishedByName ? `, ${v.publishedByName}` : ''})`;
  return (
    <Panel
      title={`${versionName(from)} compared with ${versionName(to)}`}
      description={`${describe(from)} → ${describe(to)}`}
    >
      <div className="space-y-4">
        <Link href={closeHref} className="text-sm underline">
          Close the comparison
        </Link>
        {diff.same ? (
          <p className="text-sm text-slate-700" data-testid="diff-same">
            These two versions have the same content.
          </p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label="Changes" data-testid="diff-list">
            {diff.entries.map((e, i) => (
              <li key={i} className="rounded-md border border-slate-200 px-3 py-2">
                <span className="font-medium">{CHANGE_WORDS[e.change]}: </span>
                {e.where}
                {e.field ? ` > ${e.field}` : ''}
                {e.before !== undefined || e.after !== undefined ? (
                  <span className="block text-slate-700">
                    <span className="line-through decoration-red-500">{e.before ?? ''}</span>
                    {' → '}
                    <span>{e.after ?? ''}</span>
                  </span>
                ) : null}
                {e.path ? (
                  <Link href={pathHref(e.path)} className="ml-0 block text-xs underline">
                    Show this page below
                  </Link>
                ) : null}
              </li>
            ))}
            {diff.more ? <li className="text-slate-700">… and {diff.more} more changes.</li> : null}
          </ul>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {[from, to].map((v) => (
            <figure key={v.id} className="space-y-1">
              <figcaption className="text-sm font-medium">
                {versionName(v)} ({kindLabel(v.kind)}) · page {path}
              </figcaption>
              {/* Same sandbox as the editor preview: no scripts; same origin only for the session cookie. */}
              <iframe
                title={`${versionName(v)} preview`}
                src={frame(v)}
                sandbox="allow-same-origin"
                className="h-[640px] w-full rounded-md border border-slate-200 bg-white"
              />
            </figure>
          ))}
        </div>
      </div>
    </Panel>
  );
}
