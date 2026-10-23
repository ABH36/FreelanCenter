import type { Metadata } from 'next';
import { Panel } from '@/components/ui';
import { CreateWorkspaceForm } from './create-workspace-form';

export const metadata: Metadata = { title: 'Create workspace' };

export default function NewWorkspacePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create a workspace</h1>
      <Panel
        title="Workspace details"
        description="You become its owner. Invite your team from the Members page afterwards."
      >
        <CreateWorkspaceForm />
      </Panel>
    </div>
  );
}
