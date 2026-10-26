import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PROJECT_CATEGORIES } from '@platform/workspaces';
import { createProjectAction } from '@/app/actions/projects';
import { ActionForm, SmallButton } from '@/components/action-form';
import { selectClass } from '@/components/project-ui';
import { Field, Panel } from '@/components/ui';
import { currentWorkspace } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'New project' };

/**
 * FR-PRJ-01 (P1 part: no template yet, P2) and FR-DOM-01: the project gets its platform address on creation.
 * The request key is minted per render, so submitting the same form twice creates one project.
 */
export default async function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const ws = await currentWorkspace((await params).slug);
  if (!ws.can['projects.create'] || !ws.scope.writable) notFound();
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
      <Panel title="Project" description="One client's website. You can change these later.">
        <ActionForm
          action={createProjectAction}
          hidden={{ workspaceId: ws.id, slug: ws.slug, requestKey: randomUUID() }}
          className="space-y-4"
        >
          <Field id="name" label="Business name" required maxLength={120} autoComplete="off" />
          <div className="space-y-1.5">
            <label htmlFor="category" className="block text-sm font-medium">
              Category
            </label>
            <select id="category" name="category" defaultValue="" className={selectClass}>
              <option value="">Choose later</option>
              {Object.entries(PROJECT_CATEGORIES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Field id="city" label="City" maxLength={80} />
          <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-sm font-medium">Client contact (optional)</legend>
            <Field id="contact_name" label="Name" maxLength={120} autoComplete="off" />
            <Field id="contact_phone" label="Phone" type="tel" maxLength={32} autoComplete="off" />
            <Field id="contact_whatsapp" label="WhatsApp" type="tel" maxLength={32} autoComplete="off" />
            <Field id="contact_email" label="E-mail" type="email" maxLength={320} autoComplete="off" />
          </fieldset>
          <SmallButton type="submit" variant="primary">
            Create project
          </SmallButton>
        </ActionForm>
      </Panel>
    </div>
  );
}
