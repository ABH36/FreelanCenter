'use client';
import { adminStepUpAction } from '@/app/actions/admin';
import { ActionForm, SmallButton } from '@/components/action-form';

export function StepUpForm() {
  return (
    <ActionForm action={adminStepUpAction} hidden={{}} className="flex items-end gap-2">
      <label className="block text-sm font-medium">
        Code
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
          className="mt-1 block w-36 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm tracking-widest"
        />
      </label>
      <SmallButton variant="primary">Continue</SmallButton>
    </ActionForm>
  );
}
