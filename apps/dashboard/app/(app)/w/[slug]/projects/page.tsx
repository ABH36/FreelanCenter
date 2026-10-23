import type { Metadata } from 'next';
import { currentWorkspace } from '@/lib/workspaces';
import { EmptyState } from '@/components/ui';

export const metadata: Metadata = { title: 'Projects' };

export default async function ProjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const ws = await currentWorkspace((await params).slug);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <EmptyState
        title="No projects yet"
        body={`Each project is one client's website in ${ws.name}. Creating projects arrives in the next release.`}
      />
    </div>
  );
}
