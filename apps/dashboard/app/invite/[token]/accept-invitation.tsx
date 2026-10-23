'use client';
import { useActionState } from 'react';
import { type ActionState, acceptInvitationAction } from '@/app/actions/workspaces';
import { authClient } from '@/lib/auth-client';
import { Alert, Button } from '@/components/ui';

export function AcceptInvitation({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(acceptInvitationAction, {});
  return (
    <div className="space-y-3">
      <Alert>{state.error}</Alert>
      <form action={action}>
        <input type="hidden" name="token" value={token} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Joining…' : 'Accept invitation'}
        </Button>
      </form>
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          await authClient.signOut();
          window.location.assign('/sign-in');
        }}
      >
        Use a different account
      </Button>
    </div>
  );
}
