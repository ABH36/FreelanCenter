import type { Metadata } from 'next';
import { PREVIEW_DAYS, WorkspaceError } from '@platform/workspaces';
import { createPreviewLinkAction, revokePreviewLinkAction } from '@/app/actions/templates';
import { ActionForm, CopyLink, SmallButton } from '@/components/action-form';
import { selectClass } from '@/components/project-ui';
import { Field, EmptyState, Panel } from '@/components/ui';
import { currentWorkspace, projectService, requireUserId, templateService } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Templates' };

const CATEGORY_LABEL: Record<string, string> = {
  gym: 'Gym',
  taxi: 'Taxi',
  'wedding-event': 'Wedding / event',
  distributor: 'Distributor',
  salon: 'Salon',
  clinic: 'Clinic',
  restaurant: 'Restaurant',
  coaching: 'Coaching',
  'real-estate': 'Real estate',
  generic: 'Other',
};

const DAYS_LABEL = (d: number) => (d === 1 ? '1 day' : `${d} days`);

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

/**
 * FR-TPL-09: the template catalogue and, for owners, admins and editors, a "share a preview" form that makes an
 * expiring link a prospect can open without signing in. The server action authorizes again (capability,
 * writable workspace, abuse limit) and audits; hiding the form here is only a convenience.
 *
 * P2 S10 (acceptance run 2): "View demo" on every card; the form takes the prospect's city too and is pre-filled
 * from a project (`?project=<id>`, from the project page); the links list says who each link is for and lets an
 * active link be copied again.
 */
export default async function TemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const ws = await currentWorkspace((await params).slug);
  const userId = await requireUserId();
  const service = await templateService();
  const templates = await service.catalog(userId, ws.id);
  const canShare = ws.can['templates.preview'] && ws.scope.writable;
  const links = ws.can['templates.preview'] ? await service.listPreviewLinks(userId, ws.id) : [];

  // Pre-fill from a project of this workspace; anything else (unknown, foreign, malformed) is simply ignored.
  const projectId = (await searchParams).project;
  let prefill: { name: string; city: string } | null = null;
  if (projectId) {
    try {
      const p = await (await projectService()).getProject(userId, ws.id, projectId);
      prefill = { name: p.name.slice(0, 60), city: (p.city ?? '').slice(0, 40) };
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Ready-made site designs. Share a preview link to show a prospect how their website could look, with
          their own business name and city, before you commit to anything.
        </p>
        {prefill ? (
          <p role="status" className="mt-2 text-sm text-slate-700">
            Pre-filled for <strong>{prefill.name}</strong>
            {prefill.city ? `, ${prefill.city}` : ''}. Pick a template below.
          </p>
        ) : null}
      </div>
      {!service.previewsConfigured ? (
        <p
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Preview links are not set up in this environment yet, so they cannot be created here.
        </p>
      ) : null}
      {templates.length === 0 ? (
        <EmptyState title="No templates yet" body="Published templates will appear here." />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.templateId} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{t.name}</h2>
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {CATEGORY_LABEL[t.category] ?? t.category}
                  </p>
                </div>
                {service.previewsConfigured ? (
                  <a
                    href={`/w/${ws.slug}/templates/${t.templateId}/demo`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50"
                  >
                    View demo<span className="sr-only"> of {t.name} (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
              <p className="text-sm text-slate-700">{t.description}</p>
              {canShare && service.previewsConfigured ? (
                <ActionForm
                  action={createPreviewLinkAction}
                  hidden={{ workspaceId: ws.id, templateId: t.templateId }}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <Field
                    id={`name-${t.templateId}`}
                    name="prospectName"
                    label="Prospect's business name"
                    hint="Optional. Shown in the preview instead of the demo name."
                    maxLength={60}
                    autoComplete="off"
                    defaultValue={prefill?.name ?? ''}
                  />
                  <Field
                    id={`city-${t.templateId}`}
                    name="prospectCity"
                    label="Prospect's city"
                    hint="Optional. Replaces the demo city and address."
                    maxLength={40}
                    autoComplete="off"
                    defaultValue={prefill?.city ?? ''}
                  />
                  <div className="space-y-1.5">
                    <label htmlFor={`days-${t.templateId}`} className="block text-sm font-medium">
                      Link works for
                    </label>
                    <select id={`days-${t.templateId}`} name="days" defaultValue="7" className={selectClass}>
                      {PREVIEW_DAYS.map((d) => (
                        <option key={d} value={d}>
                          {DAYS_LABEL(d)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <SmallButton type="submit" variant="primary">
                      Create preview link
                    </SmallButton>
                  </div>
                </ActionForm>
              ) : (
                <p className="text-xs text-slate-500">
                  {ws.can['templates.preview']
                    ? 'Previews cannot be created while this workspace is suspended.'
                    : 'Your role can browse templates but not share previews. Ask an owner or admin.'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {ws.can['templates.preview'] ? (
        <Panel title="Your preview links">
          {links.length === 0 ? (
            <p className="text-sm text-slate-600">
              No links yet. Create one above; it will be listed here so you can copy it again or turn it off.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200">
              {links.map((l) => (
                <li key={l.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">
                        {l.prospectName ?? (l.personalised ? 'A prospect' : 'No prospect name')}
                        {l.prospectCity ? (
                          <span className="font-normal text-slate-600">, {l.prospectCity}</span>
                        ) : null}
                        <span className="font-normal text-slate-600"> · {l.templateName}</span>
                      </p>
                      <p className="text-xs text-slate-600">
                        Made {formatDay(l.createdAt)} ·{' '}
                        {l.status === 'revoked'
                          ? `turned off ${formatDay(l.revokedAt as string)}`
                          : l.status === 'expired'
                            ? `expired ${formatDay(l.expiresAt)}`
                            : `works until ${formatDay(l.expiresAt)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          l.status === 'active'
                            ? 'bg-emerald-50 text-emerald-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {l.status === 'active' ? 'Active' : l.status === 'expired' ? 'Expired' : 'Turned off'}
                      </span>
                      {l.status === 'active' ? (
                        <ActionForm
                          action={revokePreviewLinkAction}
                          hidden={{ workspaceId: ws.id, linkId: l.id }}
                          confirm={`Turn off the link for ${l.prospectName ?? 'this prospect'}? Anyone who has it will see that it was withdrawn. This cannot be undone.`}
                          confirmLabel="Turn off"
                        >
                          <SmallButton type="submit" variant="danger">
                            Turn off
                          </SmallButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  </div>
                  {l.url ? (
                    <CopyLink
                      link={l.url}
                      label={`Preview link for ${l.prospectName ?? l.templateName}`}
                      note="Anyone with this link can open the preview until it expires."
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-600">
            Links made before this list existed are not shown and cannot be turned off; they expire on their
            own date.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
