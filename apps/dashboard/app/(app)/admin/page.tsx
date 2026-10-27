import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin';

export default async function AdminHome() {
  await requireAdmin();
  redirect('/admin/workspaces');
}
