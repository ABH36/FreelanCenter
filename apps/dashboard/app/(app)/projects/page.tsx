import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui';

export const metadata: Metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <EmptyState
        title="No projects yet"
        body="Each project is one client's website. You will be able to create projects once you have a workspace."
      />
    </div>
  );
}
