'use client';
import { useRef, useState, type FormEvent } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, AuthCard, Button, Field, TextLink } from '@/components/ui';
import { Turnstile, type TurnstileHandle } from '@/components/turnstile';

export function ForgotPasswordForm({ siteKey }: { siteKey: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const captcha = useRef<TurnstileHandle>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return setError(authErrorMessage({ code: 'MISSING_RESPONSE' }));
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    const { error } = await authClient.requestPasswordReset(
      { email: String(form.get('email')), redirectTo: '/reset-password' },
      { headers: { 'x-captcha-response': token } },
    );
    captcha.current?.reset();
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    setSent(true);
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your account email and we will send you a reset link."
      footer={<TextLink href="/sign-in">Back to sign in</TextLink>}
    >
      {sent ? (
        // Identical for known and unknown addresses (FR-AUTH-04).
        <Alert tone="success">
          If an account exists for that address, a reset link is on its way. It works once and expires in 15
          minutes.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Alert>{error}</Alert>
          <Field id="email" label="Email" type="email" autoComplete="email" required />
          <Turnstile ref={captcha} siteKey={siteKey} action="password-reset" onToken={setToken} />
          <Button type="submit" disabled={pending || !token}>
            {pending ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
