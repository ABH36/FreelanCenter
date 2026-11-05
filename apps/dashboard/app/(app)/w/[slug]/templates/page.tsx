import type { Metadata } from 'next';
import { PREVIEW_DAYS } from '@platform/workspaces';
import { createPreviewLinkAction } from '@/app/actions/templates';
import { ActionForm, SmallButton } from '@/components/action-form';
import { selectClass } from '@/components/project-ui';
import { Field, EmptyState } from '@/components/ui';
import { currentWorkspace, requireUserId, templateService } from '@/lib/workspaces';

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

/**
 * FR-TPL-09: the template catalogue and, for owners, admins and editors, a "share a preview" form that makes an
 * expiring link a prospect can open without signing in. The server action authorizes again (capability,
 * writable workspace, abuse limit) and audits; hiding the form here is only a convenience.
 */
export default async function TemplatesPage({ params }: { params: Promise<{ slug: string }> }) {
  const ws = await currentWorkspace((await params).slug);
  const userId = await requireUserId();
  const service = await templateService();
  const templates = await service.catalog(userId, ws.id);
  const canShare = ws.can['templates.preview'] && ws.scope.writable;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Ready-made site designs. Share a preview link to show a prospect how their website could look, using
          their own business name, before you commit to anything.
        </p>
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
              <div>
                <h2 className="text-lg font-semibold">{t.name}</h2>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {CATEGORY_LABEL[t.category] ?? t.category}
                </p>
                <p className="mt-1 text-sm text-slate-700">{t.description}</p>
              </div>
              {canShare && service.previewsConfigured ? (
                <ActionForm
                  action={createPreviewLinkAction}
                  hidden={{ workspaceId: ws.id, templateId: t.templateId }}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="min-w-48 flex-1">
                    <Field
                      id={`name-${t.templateId}`}
                      name="prospectName"
                      label="Prospect's business name (optional)"
                      maxLength={60}
                      autoComplete="off"
                    />
                  </div>
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
                  <SmallButton type="submit" variant="primary">
                    Create preview link
                  </SmallButton>
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
    </div>
  );
}
