'use client';
import { useState, type FormEvent } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, AuthCard, Button, Divider, Field, TextLink } from '@/components/ui';
import { GoogleButton } from '@/components/google-button';

export function SignInForm({ googleEnabled, oauthError }: { googleEnabled: boolean; oauthError: boolean }) {
  const [error, setError] = useState(oauthError ? 'Google sign-in did not complete. Try again.' : '');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    const { data, error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    if (error) {
      setError(authErrorMessage(error));
      setPending(false);
      return;
    }
    // A TOTP user gets a challenge instead of a session; the client plugin navigates to /two-factor.
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return;
    window.location.assign('/');
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Welcome back."
      footer={
        <>
          New here? <TextLink href="/sign-up">Create an account</TextLink>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        <Field id="email" label="Email" type="email" autoComplete="email" required />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required />
        <div className="flex justify-end text-sm">
          <TextLink href="/forgot-password">Forgot password?</TextLink>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {googleEnabled ? (
        <>
          <Divider label="or" />
          <GoogleButton />
        </>
      ) : null}
    </AuthCard>
  );
}
