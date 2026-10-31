'use client';
import { setWorkspaceStatusAction } from '@/app/actions/admin';
import { ActionForm, SmallButton } from '@/components/action-form';

/** Suspend or reactivate with a required reason (3-500 characters, stored in the audit row). */
export function StatusForm({ workspaceId, to }: { workspaceId: string; to: 'active' | 'suspended' }) {
  return (
    <ActionForm
      action={setWorkspaceStatusAction}
      hidden={{ workspaceId, status: to }}
      confirm={to === 'suspended' ? 'Suspend this workspace and take its sites offline?' : undefined}
      className="space-y-2"
    >
      <label className="block text-sm font-medium">
        Reason
        <textarea
          name="reason"
          required
          minLength={3}
          maxLength={500}
          rows={3}
          placeholder={to === 'suspended' ? 'e.g. phishing report #123' : 'e.g. appeal accepted'}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <SmallButton variant={to === 'suspended' ? 'danger' : 'primary'}>
        {to === 'suspended' ? 'Suspend workspace' : 'Reactivate workspace'}
      </SmallButton>
    </ActionForm>
  );
}
