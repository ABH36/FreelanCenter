import type { Metadata } from 'next';
import { cancelDeletionAction, renameWorkspaceAction, requestDeletionAction } from '@/app/actions/workspaces';
import { ActionForm, SmallButton } from '@/components/action-form';
import { Field, Panel } from '@/components/ui';
import { currentWorkspace } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Workspace settings' };

/** FR-WS-02 settings; FR-WS-05 deletion request (the purge itself is the P8 retention job). */
export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const ws = await currentWorkspace((await params).slug);
  const writable = ws.scope.writable;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Workspace settings</h1>
      <Panel title="General">
        <dl className="mb-5 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-slate-500">Address</dt>
          <dd className="font-mono">/w/{ws.slug}</dd>
          <dt className="text-slate-500">Created</dt>
          <dd>{ws.createdAt.toUTCString()}</dd>
        </dl>
        {ws.can['workspace.update'] && writable ? (
          <ActionForm
            action={renameWorkspaceAction}
            hidden={{ workspaceId: ws.id }}
            className="flex max-w-md flex-col gap-3"
          >
            <Field id="name" label="Workspace name" defaultValue={ws.name} required maxLength={100} />
            <div>
              <SmallButton type="submit" variant="primary">
                Save
              </SmallButton>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm text-slate-600">Only owners and admins can change these settings.</p>
        )}
      </Panel>

      {ws.can['workspace.delete'] ? (
        <Panel
          title="Delete workspace"
          description="Deletion is scheduled 30 days ahead. Until then the workspace is read-only and you can cancel. After that its projects, sites and data are purged."
        >
          {ws.deletionScheduledFor ? (
            <ActionForm action={cancelDeletionAction} hidden={{ workspaceId: ws.id }}>
              <SmallButton type="submit" variant="primary">
                Cancel deletion
              </SmallButton>
            </ActionForm>
          ) : ws.status === 'active' ? (
            <ActionForm
              action={requestDeletionAction}
              hidden={{ workspaceId: ws.id }}
              className="flex max-w-md flex-col gap-3"
              confirm={`Schedule ${ws.name} for deletion?`}
            >
              <Field
                id="confirmSlug"
                label={`Type ${ws.slug} to confirm`}
                required
                autoComplete="off"
                spellCheck={false}
              />
              <div>
                <SmallButton type="submit" variant="danger">
                  Schedule deletion
                </SmallButton>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-slate-600">
              A suspended workspace cannot be deleted. Contact support.
            </p>
          )}
        </Panel>
      ) : null}
    </>
  );
}
