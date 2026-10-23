'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, AuthCard, Button, Field, TextLink } from '@/components/ui';

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  // Drop the token from the address bar and history once it is in memory.
  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/reset-password');
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('password'));
    if (newPassword !== String(form.get('confirm'))) return setError('The passwords do not match.');
    setPending(true);
    setError('');
    const { error } = await authClient.resetPassword({ token, newPassword });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    setDone(true);
  }

  if (!token) {
    return (
      <AuthCard title="Link invalid or expired" subtitle="Reset links work once and expire after 15 minutes.">
        <TextLink href="/forgot-password">Request a new link</TextLink>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard
        title="Password updated"
        subtitle="You have been signed out everywhere. Sign in with your new password."
      >
        <TextLink href="/sign-in">Sign in</TextLink>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" subtitle="This signs you out on every device.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          hint="At least 12 characters."
          required
        />
        <Field id="confirm" label="Confirm password" type="password" autoComplete="new-password" required />
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Update password'}
        </Button>
      </form>
    </AuthCard>
  );
}
