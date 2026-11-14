import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { editorFormSchemas } from '@platform/schema';
import { type DraftView, WorkspaceError } from '@platform/workspaces';
import { startDraftAction } from '@/app/actions/builder';
import { ActionForm } from '@/components/action-form';
import { Panel } from '@/components/ui';
import {
  builderService,
  currentWorkspace,
  projectService,
  requireUserId,
  templateService,
  workspaces,
} from '@/lib/workspaces';
import { type ClientDraft, Editor } from './editor';
import type { JsonSchema } from './schema-form';

export const metadata: Metadata = { title: 'Edit site' };

/**
 * P3 S3 (module 05): the site editor. The project id is a selector: another workspace's project and an unknown id are
 * the same 404. Without a draft yet, the page offers the template catalogue (FR-PRJ-01). Registered with the IDOR
 * harness as `page:/w/[slug]/projects/[projectId]/editor`.
 */
export default async function EditorPage({
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
  let draft: DraftView | null = null;
  try {
    draft = await (await builderService()).getDraft(userId, ws.id, project.id);
  } catch (error) {
    if (!(error instanceof WorkspaceError && error.code === 'NO_DRAFT')) throw error;
  }
  const canEdit = ws.can['draft.edit'] && ws.scope.writable && project.status !== 'archived';

  const header = (
    <div>
      <Link href={`/w/${ws.slug}/projects/${project.id}`} className="text-sm text-slate-600 hover:underline">
        ← {project.name}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit site</h1>
    </div>
  );

  if (!draft) {
    const catalog = await (await templateService()).catalog(userId, ws.id);
    return (
      <div className="space-y-6">
        {header}
        <Panel
          title="Choose a template"
          description="The site starts from the template's design and demo content; you then change everything in the editor."
        >
          {canEdit ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {catalog.map((t) => (
                <li
                  key={t.templateId}
                  className="space-y-2 rounded-[var(--radius-base)] border border-slate-200 p-4"
                >
                  <h2 className="font-medium">{t.name}</h2>
                  <p className="text-sm text-slate-600">{t.description}</p>
                  <ActionForm
                    action={startDraftAction}
                    hidden={{
                      workspaceId: ws.id,
                      projectId: project.id,
                      templateId: t.templateId,
                      slug: ws.slug,
                    }}
                  >
                    <button
                      type="submit"
                      className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                    >
                      Start with {t.name}
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">
              This project has no site yet. An owner, admin or editor can start one.
            </p>
          )}
        </Panel>
      </div>
    );
  }

  const members = await (await workspaces()).listMembers(userId, ws.id);
  const schemas = editorFormSchemas();
  return (
    <div className="space-y-6">
      {header}
      <Editor
        workspaceId={ws.id}
        slug={ws.slug}
        // Plain JSON across the server/client boundary (dates become strings; the editor needs none of them).
        initial={JSON.parse(JSON.stringify(draft)) as ClientDraft}
        schemas={{
          business: JSON.parse(JSON.stringify(schemas.business)) as JsonSchema,
          blocks: JSON.parse(JSON.stringify(schemas.blocks)) as Record<string, JsonSchema>,
        }}
        canEdit={canEdit}
        canTakeOver={canEdit && (ws.scope.role === 'owner' || ws.scope.role === 'admin')}
        memberNames={Object.fromEntries(members.map((m) => [m.userId, m.name]))}
      />
    </div>
  );
}
