import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PROJECT_CATEGORIES, WorkspaceError } from '@platform/workspaces';
import {
  duplicateProjectAction,
  removeClientContactAction,
  saveClientContactAction,
  transitionProjectAction,
  updateProjectAction,
} from '@/app/actions/projects';
import { ActionForm, SmallButton } from '@/components/action-form';
import { StatusBadge, selectClass } from '@/components/project-ui';
import { Field, Panel } from '@/components/ui';
import { currentWorkspace, projectService, requireUserId } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Project' };

/**
 * One project (FR-PRJ-02/03/05). The id in the URL is a selector: another workspace's project and an unknown id
 * are the same 404. The buttons are the transitions the server allows this member now; every submission is
 * re-authorized by the service and the database.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
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
  const hidden = { workspaceId: ws.id, projectId: project.id };
  const sub = project.health.subdomain;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/w/${ws.slug}/projects`} className="text-sm text-slate-600 hover:underline">
          ← Projects
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <StatusBadge status={project.status} />
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Address: {sub ? <span className="font-mono">{sub.hostname}</span> : 'none'}
          {sub && sub.status !== 'active' ? ` (${sub.status})` : ''}
          {project.duplicatedFrom ? (
            <>
              {' · Copied from '}
              <Link href={`/w/${ws.slug}/projects/${project.duplicatedFrom.id}`} className="hover:underline">
                {project.duplicatedFrom.name}
              </Link>
            </>
          ) : null}
        </p>
      </div>

      <Panel
        title="Status"
        description="Draft → In review → Approved → Live, with Pause, Archive and Restore. Every change is recorded."
      >
        {project.transitions.length ? (
          <div className="flex flex-wrap gap-2">
            {project.transitions.map((t) => (
              <ActionForm
                key={t.to}
                action={transitionProjectAction}
                hidden={{ ...hidden, from: t.from, to: t.to }}
                confirm={t.to === 'archived' ? `Archive ${project.name}?` : undefined}
              >
                <SmallButton type="submit" variant={t.to === 'archived' ? 'danger' : 'secondary'}>
                  {t.label}
                </SmallButton>
              </ActionForm>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-600">There is nothing you can change here right now.</p>
        )}
      </Panel>

      <Panel title="Details">
        {project.canEdit ? (
          <ActionForm action={updateProjectAction} hidden={hidden} className="space-y-4">
            <Field id="name" label="Business name" required maxLength={120} defaultValue={project.name} />
            <div className="space-y-1.5">
              <label htmlFor="category" className="block text-sm font-medium">
                Category
              </label>
              <select
                id="category"
                name="category"
                defaultValue={project.category ?? ''}
                className={selectClass}
              >
                <option value="">Not set</option>
                {Object.entries(PROJECT_CATEGORIES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <Field id="city" label="City" maxLength={80} defaultValue={project.city ?? ''} />
            <SmallButton type="submit">Save details</SmallButton>
          </ActionForm>
        ) : (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Category</dt>
            <dd>
              {project.category
                ? PROJECT_CATEGORIES[project.category as keyof typeof PROJECT_CATEGORIES]
                : '—'}
            </dd>
            <dt className="text-slate-500">City</dt>
            <dd>{project.city ?? '—'}</dd>
          </dl>
        )}
      </Panel>

      <Panel
        title="Client contact"
        description="The business owner you build this site for. Only members of this workspace see it."
      >
        {project.canEdit ? (
          <div className="space-y-3">
            <ActionForm action={saveClientContactAction} hidden={hidden} className="space-y-4">
              <Field
                id="name"
                label="Name"
                required
                maxLength={120}
                defaultValue={project.contact?.name ?? ''}
              />
              <Field
                id="phone"
                label="Phone"
                type="tel"
                maxLength={32}
                defaultValue={project.contact?.phone ?? ''}
              />
              <Field
                id="whatsapp"
                label="WhatsApp"
                type="tel"
                maxLength={32}
                defaultValue={project.contact?.whatsapp ?? ''}
              />
              <Field
                id="email"
                label="E-mail"
                type="email"
                maxLength={320}
                defaultValue={project.contact?.email ?? ''}
              />
              <SmallButton type="submit">Save contact</SmallButton>
            </ActionForm>
            {project.contact ? (
              <ActionForm action={removeClientContactAction} hidden={hidden} confirm="Remove this contact?">
                <SmallButton type="submit" variant="danger">
                  Remove contact
                </SmallButton>
              </ActionForm>
            ) : null}
          </div>
        ) : project.contact ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Name</dt>
            <dd>{project.contact.name}</dd>
            <dt className="text-slate-500">Phone</dt>
            <dd>{project.contact.phone ?? '—'}</dd>
            <dt className="text-slate-500">WhatsApp</dt>
            <dd>{project.contact.whatsapp ?? '—'}</dd>
            <dt className="text-slate-500">E-mail</dt>
            <dd>{project.contact.email ?? '—'}</dd>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">No contact yet.</p>
        )}
      </Panel>

      {project.canDuplicate ? (
        <Panel
          title="Duplicate"
          description="A new Draft with the same details and its own address. The contact is not copied."
        >
          <ActionForm
            action={duplicateProjectAction}
            hidden={{ ...hidden, slug: ws.slug, requestKey: randomUUID() }}
          >
            <SmallButton type="submit">Duplicate as draft</SmallButton>
          </ActionForm>
        </Panel>
      ) : null}
    </div>
  );
}
