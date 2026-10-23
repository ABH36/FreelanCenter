'use client';
import { useRef, useState, type FormEvent } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, AuthCard, Button, Divider, Field, TextLink } from '@/components/ui';
import { GoogleButton } from '@/components/google-button';
import { Turnstile, type TurnstileHandle } from '@/components/turnstile';
import { CheckInbox } from '../verify-email/check-inbox';

export function SignUpForm({ siteKey, googleEnabled }: { siteKey: string; googleEnabled: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const captcha = useRef<TurnstileHandle>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return setError(authErrorMessage({ code: 'MISSING_RESPONSE' }));
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    setPending(true);
    setError('');
    const { error } = await authClient.signUp.email(
      {
        name: String(form.get('name')),
        email,
        password: String(form.get('password')),
        callbackURL: '/verified',
      },
      { headers: { 'x-captcha-response': token } },
    );
    captcha.current?.reset();
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    // The same response for new and already-registered addresses (no enumeration).
    setSentTo(email);
  }

  if (sentTo) return <CheckInbox email={sentTo} siteKey={siteKey} />;

  return (
    <AuthCard
      title="Create your account"
      subtitle="Build and deliver client websites from one dashboard."
      footer={
        <>
          Already have an account? <TextLink href="/sign-in">Sign in</TextLink>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        <Field id="name" label="Full name" autoComplete="name" required maxLength={100} />
        <Field id="email" label="Work email" type="email" autoComplete="email" required />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          hint="At least 12 characters."
          required
        />
        <Turnstile ref={captcha} siteKey={siteKey} action="sign-up" onToken={setToken} />
        <Button type="submit" disabled={pending || !token}>
          {pending ? 'Creating account…' : 'Create account'}
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
