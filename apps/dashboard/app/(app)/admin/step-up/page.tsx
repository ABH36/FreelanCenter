import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert, Panel } from '@/components/ui';
import { adminContext } from '@/lib/admin';
import { StepUpForm } from './step-up-form';

export const metadata: Metadata = { title: 'Confirm it is you' };

/**
 * SEC-17 step-up. Signing in with Google skips Better Auth's TOTP challenge, so the console asks for a current
 * code on every session, again after 15 minutes. Five wrong codes lock it for 15 minutes (database-enforced).
 */
export default async function StepUpPage() {
  const { state } = await adminContext();
  if (state.stepUpUntil) redirect('/admin/workspaces');
  return (
    <div className="max-w-md">
      <Panel
        title="Confirm it is you"
        description="Enter the current 6-digit code from your authenticator app to open the admin console for 15 minutes."
      >
        {state.lockedUntil ? (
          <Alert>
            Too many wrong codes. Try again after {state.lockedUntil.toISOString().slice(11, 16)} UTC.
          </Alert>
        ) : (
          <StepUpForm />
        )}
      </Panel>
    </div>
  );
}
